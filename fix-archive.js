/**
 * fix-archive.js — one-off script to:
 * 1. Merge editions from the same day into one (fixes double-run problem)
 * 2. Remove duplicate articles across all editions (keeps longest summary)
 * 3. Generate missing questionB1 / questionB2 for articles that don't have them
 *
 * Run once: node fix-archive.js
 * Requires ANTHROPIC_API_KEY in environment.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';

function normaliseTitle(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const raw = await fs.readFile('news.json', 'utf8');
  const archive = JSON.parse(raw);

  // ── STEP 1: Merge same-day editions ─────────────────────────────────────
  console.log('📅 Merging same-day editions…');
  const byDay = {};
  for (const edition of archive.editions) {
    const day = edition.generated.slice(0, 10);
    if (!byDay[day]) {
      byDay[day] = { ...edition, articles: [...(edition.articles || [])] };
    } else {
      // Merge articles from later run into earlier one
      byDay[day].articles.push(...(edition.articles || []));
      console.log(`  🔗 Merged extra run on ${day} (${(edition.articles || []).length} articles)`);
    }
  }
  // Rebuild editions array sorted newest first
  archive.editions = Object.values(byDay).sort((a, b) =>
    new Date(b.generated) - new Date(a.generated)
  );

  // ── STEP 2: Deduplicate across ALL editions ──────────────────────────────
  console.log('🔍 Deduplicating articles…');
  const seenTitles = new Map();

  for (let ei = 0; ei < archive.editions.length; ei++) {
    const keepArticles = [];
    for (const article of (archive.editions[ei].articles || [])) {
      const key = normaliseTitle(article.title);
      if (seenTitles.has(key)) {
        const prev = seenTitles.get(key);
        const prevArt = archive.editions[prev.ei].articles[prev.ai];
        if ((article.summaryB2 || '').length > (prevArt.summaryB2 || '').length) {
          archive.editions[prev.ei].articles[prev.ai] = article;
          console.log(`  ♻️  Kept better version of: "${article.title.slice(0, 60)}"`);
        } else {
          console.log(`  🗑  Removed duplicate: "${article.title.slice(0, 60)}"`);
        }
      } else {
        seenTitles.set(key, { ei, ai: keepArticles.length });
        keepArticles.push(article);
      }
    }
    archive.editions[ei].articles = keepArticles;
  }

  // ── STEP 3: Generate missing questions ──────────────────────────────────
  console.log('\n💭 Generating missing Food for Thought questions…');
  let questionsGenerated = 0;

  for (const edition of archive.editions) {
    for (const article of (edition.articles || [])) {
      if (article.questionB1 && article.questionB2) continue;
      console.log(`  📝 Generating questions for: "${article.title.slice(0, 60)}"`);
      try {
        const prompt = `You are an expert EFL teacher. Based on these article summaries and vocabulary, generate two discussion questions.

Article title: ${article.title}
B1 Summary: ${article.summaryB1}
B1 Vocabulary: ${(article.vocabularyB1 || []).map(v => v.word).join(', ')}
B2 Summary: ${article.summaryB2}
B2 Vocabulary: ${(article.vocabularyB2 || []).map(v => v.word).join(', ')}

Generate a JSON object with exactly these two fields (no markdown, no code fences):
{
  "questionB1": "A single open-ended question (max 25 words) for B1 learners. Must use 1-2 words from B1 vocabulary. Thought-provoking but accessible. Never use: important, significant, broader, increasingly, underscores.",
  "questionB2": "A single open-ended question (max 35 words) for B2-C1 learners. Must use 1-2 words from B2 vocabulary. Analytically challenging. Never use: important, significant, broader, increasingly, underscores."
}`;

        const msg = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }]
        });

        const text = (msg.content[0]?.text || '{}')
          .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
        const parsed = JSON.parse(text);
        article.questionB1 = parsed.questionB1 || '';
        article.questionB2 = parsed.questionB2 || '';
        questionsGenerated++;
        await new Promise(r => setTimeout(r, 400));
      } catch (err) {
        console.warn(`  ⚠️  Failed: ${err.message}`);
      }
    }
  }

  // ── STEP 4: Save ─────────────────────────────────────────────────────────
  await fs.writeFile('news.json', JSON.stringify(archive, null, 2), 'utf8');
  const total = archive.editions.reduce((n, e) => n + (e.articles || []).length, 0);
  console.log(`\n✨ Done! ${total} articles across ${archive.editions.length} edition(s). ${questionsGenerated} questions generated.`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
