/**
 * English Lens — Weekly News Fetcher
 * Runs every Monday at 07:30 Warsaw time via GitHub Actions.
 * Fetches RSS feeds, filters for relevance, generates B1 & B2-C1 summaries
 * with vocabulary using the Claude API, then writes public/news.json.
 */

import Anthropic from '@anthropic-ai/sdk';
import Parser from 'rss-parser';
import fs from 'fs/promises';
import path from 'path';

// ── CONFIG ────────────────────────────────────────────────────────────────────

const ARTICLES_PER_RUN = 10;   // Total articles to include in the weekly edition
const MAX_PER_CATEGORY = 3;    // No single category dominates

const FEEDS = [
  // Politics / EU / Europe
  { url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml',      category: 'politics',     name: 'BBC News Europe' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',             category: 'politics',     name: 'BBC News World' },
  { url: 'https://www.euronews.com/rss',                             category: 'politics',     name: 'Euronews' },
  { url: 'https://rss.politico.eu/politics',                         category: 'politics',     name: 'Politico Europe' },
  { url: 'https://notesfrompoland.com/feed/',                        category: 'politics',     name: 'Notes from Poland' },

  // Business / Economy
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',          category: 'business',     name: 'BBC Business' },
  { url: 'https://feeds.reuters.com/reuters/businessNews',           category: 'business',     name: 'Reuters Business' },

  // Technology
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',        category: 'technology',   name: 'BBC Technology' },
  { url: 'https://feeds.reuters.com/reuters/technologyNews',         category: 'technology',   name: 'Reuters Technology' },

  // Environment / Science
  { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'environment', name: 'BBC Science & Environment' },

  // Culture
  { url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', category: 'culture', name: 'BBC Culture' },
  { url: 'https://www.theguardian.com/culture/rss',                  category: 'culture',      name: 'The Guardian Culture' },
];

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🗞  English Lens — starting weekly fetch…');

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const parser = new Parser({ timeout: 10000 });

  // 1. Fetch all RSS feeds
  const candidates = await fetchAllFeeds(parser);
  console.log(`📥  Fetched ${candidates.length} candidate articles`);

  // 2. Filter for relevance to Polish / Central European readers
  const relevant = await filterRelevant(client, candidates);
  console.log(`✅  ${relevant.length} articles passed relevance filter`);

  // 3. Select a balanced set across categories
  const selected = selectBalanced(relevant, ARTICLES_PER_RUN, MAX_PER_CATEGORY);
  console.log(`🎯  Selected ${selected.length} articles for this week`);

  // 4. Generate summaries and vocabulary for each
  const articles = [];
  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    console.log(`📝  [${i + 1}/${selected.length}] Summarising: ${item.title}`);
    try {
      const enriched = await summariseArticle(client, item);
      articles.push(enriched);
    } catch (err) {
      console.error(`  ⚠️  Failed for "${item.title}": ${err.message}`);
    }
  }

  // 5. Write output
  const output = {
    generated: new Date().toISOString(),
    week: getISOWeek(),
    articles,
  };

  const outPath = 'news.json';
  await fs.writeFile(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✨  Done! Wrote ${articles.length} articles to ${outPath}`);
}

// ── FEED FETCHING ─────────────────────────────────────────────────────────────

async function fetchAllFeeds(parser) {
  const results = [];
  const seenTitles = new Set();

  await Promise.allSettled(
    FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        for (const item of (parsed.items || []).slice(0, 8)) {
          if (!item.title || !item.link) continue;
          const key = item.title.toLowerCase().trim();
          if (seenTitles.has(key)) continue;
          seenTitles.add(key);
          results.push({
            title: item.title.trim(),
            originalUrl: item.link,
            source: feed.name,
            category: feed.category,
            date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
            snippet: stripHtml(item.contentSnippet || item.summary || item.content || '').slice(0, 600),
          });
        }
      } catch (err) {
        console.warn(`  ⚠️  Feed failed (${feed.name}): ${err.message}`);
      }
    })
  );

  return results;
}

// ── RELEVANCE FILTER ──────────────────────────────────────────────────────────

async function filterRelevant(client, candidates) {
  // Batch candidates into groups of 10 to save API calls
  const BATCH = 10;
  const relevant = [];

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const list = batch.map((a, idx) =>
      `${idx + 1}. [${a.category.toUpperCase()}] ${a.title}\n   ${a.snippet.slice(0, 150)}`
    ).join('\n\n');

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are helping curate a weekly English-language news digest for people living in Poland and Central Europe.

For each article below, decide: is it RELEVANT to Polish/Central European readers? 
Relevant = affects the EU, European economy, European culture, technology trends in Europe, or international news that Polish people would care about.
Not relevant = purely local US/UK/Asian news with no European angle.

Reply with ONLY the numbers of relevant articles, comma-separated. Example: 1,3,5,7

Articles:
${list}`
      }]
    });

    const text = msg.content[0]?.text?.trim() || '';
    const indices = text.split(',').map(s => parseInt(s.trim()) - 1).filter(n => n >= 0 && n < batch.length);
    indices.forEach(idx => relevant.push(batch[idx]));

    // Small delay to be kind to the API
    if (i + BATCH < candidates.length) await sleep(500);
  }

  return relevant;
}

// ── ARTICLE SELECTION ─────────────────────────────────────────────────────────

function selectBalanced(articles, total, maxPerCat) {
  const byCat = {};
  for (const a of articles) {
    if (!byCat[a.category]) byCat[a.category] = [];
    byCat[a.category].push(a);
  }

  const selected = [];
  let round = 0;
  while (selected.length < total && round < maxPerCat) {
    for (const cat of Object.keys(byCat)) {
      if (selected.length >= total) break;
      if (byCat[cat][round]) selected.push(byCat[cat][round]);
    }
    round++;
  }
  return selected;
}

// ── SUMMARISATION ─────────────────────────────────────────────────────────────

async function summariseArticle(client, item) {
  const prompt = `You are an expert EFL teacher creating reading materials for Polish English learners (adults, B1–C1 level).

Article details:
Title: ${item.title}
Source: ${item.source}
Category: ${item.category}
Snippet: ${item.snippet}

Generate a JSON object with EXACTLY these fields (no markdown, no extra text):
{
  "summaryB1": "A 80-100 word summary of this news story. Use simple, clear language suitable for B1 (intermediate) English learners. Short sentences. Common vocabulary. Present the main facts clearly.",
  "summaryB2": "A 100-120 word summary of the same story. Use richer, more complex language suitable for B2-C1 learners. Include nuance, context, and more sophisticated sentence structures. Use journalistic language naturally.",
  "vocabulary": [
    { "word": "example word or phrase from the B2 summary", "definition": "A clear, concise definition in simple English (max 20 words)" },
    { "word": "another key term", "definition": "Definition" },
    { "word": "third term", "definition": "Definition" },
    { "word": "fourth term", "definition": "Definition" },
    { "word": "fifth term", "definition": "Definition" }
  ]
}

Rules:
- The vocabulary items must be words or phrases that actually appear in your B2 summary
- Choose genuinely challenging words worth learning — not basic words
- Definitions must be simple enough for a B1 learner to understand
- Do not invent facts not present in the snippet; keep to what is known`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = msg.content[0]?.text?.trim() || '{}';
  const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    console.warn('  ⚠️  JSON parse failed, using fallback');
    parsed = { summaryB1: item.snippet, summaryB2: item.snippet, vocabulary: [] };
  }

  return {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    title: item.title,
    source: item.source,
    sourceUrl: item.originalUrl,
    category: item.category,
    date: item.date,
    originalUrl: item.originalUrl,
    summaryB1: parsed.summaryB1 || '',
    summaryB2: parsed.summaryB2 || '',
    vocabulary: (parsed.vocabulary || []).slice(0, 5),
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getISOWeek() {
  const d = new Date();
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const week = Math.ceil(((d - jan4) / 86400000 + jan4.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── RUN ───────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
