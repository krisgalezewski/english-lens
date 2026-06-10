/**
 * fix-archive.js — one-off script to:
 * 1. Remove duplicate articles from news.json (keeps longest summary)
 * 2. Generate missing questionB1 / questionB2 for articles that don't have them
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

  // Load archive
  const raw = await fs.readFile('news.json', 'utf8');
  const archive = JSON.parse(raw);

  // ── STEP 1: Deduplicate across ALL editions ──────────────────────────────
  console.log('🔍 Deduplicating articles across all editions…');
  const seenTitles = new Map(); // normalisedTitle → { editionIdx, articleIdx }

  for (let ei = 0; ei < archive.editions.length; ei++) {
    const edition = archive.editions[ei];
    const keepArticles = [];

    for (const article of (edition.articles || [])) {
      const key = normaliseTitle(article.title);

      if (seenTitles.has(key)) {
        // Duplicate found — keep whichever has the longer summaryB2
        const prev = seenTitles.get(key);
        const prevArt = archive.editions[prev.ei].articles[prev.ai];
        const prevLen = (prevArt.summaryB2 || '').length;
        const thisLen = (article.summaryB2 || '').length;

        if (thisLen > prevLen) {
          // This one is better — replace the previous, skip this slot
          archive.editions[prev.ei].articles[prev.ai] = article;
          console.log(`  ♻️  Kept better version of: "${article.title}"`);
        } else {
          console.log(`  🗑  Removed duplicate: "${article.title}"`);
        }
        // Don't add to keepArticles — either way, we skip this one
      } else {
        seenTitles.set(key, { ei, ai: keepArticles.length });
        keepArticles.push(article);
      }
    }

    archive.editions[ei].articles = keepArticles;
  }

  // ── STEP 2: Generate missing questions ──────────────────────────────────
  console.log('\n💭 Generating missing Food for Thought questions…');
  let questionsGenerated = 0;

  for (const edition of archive.editions) {
    for (const article of (edition.articles || [])) {
      if (article.questionB1 && article.questionB2) continue;

      console.log(`  📝 Generating questions for: "${article.title}"`);
      try {
        const prompt = `You are an expert EFL teacher. Based on the following article summaries and vocabulary, generate two discussion questions.

Article title: ${article.title}

B1 Summary: ${article.summaryB1}
B1 Vocabulary: ${(article.vocabularyB1 || []).map(v => v.word).join(', ')}

B2 Summary: ${article.summaryB2}
B2 Vocabulary: ${(article.vocabularyB2 || []).map(v => v.word).join(', ')}

Generate a JSON object with exactly these two fields (no markdown, no code fences):
{
  "questionB1": "A single open-ended question (max 25 words) for B1 learners about the main idea. Must naturally use 1 or 2 words from the B1 vocabulary list. Thought-provoking but accessible. Do NOT use the words: important, significant, broader, increasingly, underscores, raises concerns.",
  "questionB2": "A single open-ended question (max 35 words) for B2-C1 learners for critical analysis. Must naturally use 1 or 2 words from the B2 vocabulary list. Analytically challenging. Do NOT use the words: important, significant, broader, increasingly, underscores, raises concerns."
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

        // Small delay to be kind to the API
        await new Promise(r => setTimeout(r, 400));
      } catch (err) {
        console.warn(`  ⚠️  Failed for "${article.title}": ${err.message}`);
      }
    }
  }

  // ── STEP 3: Save ─────────────────────────────────────────────────────────
  await fs.writeFile('news.json', JSON.stringify(archive, null, 2), 'utf8');

  const totalArticles = archive.editions.reduce((n, e) => n + (e.articles || []).length, 0);
  console.log(`\n✨ Done!`);
  console.log(`   ${totalArticles} articles remaining across ${archive.editions.length} edition(s)`);
  console.log(`   ${questionsGenerated} questions generated`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
