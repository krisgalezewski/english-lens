/**
 * English Lens — Weekly News Fetcher
 * Runs every Monday at 07:30 Warsaw time via GitHub Actions.
 * Fetches RSS feeds, filters for relevance, generates B1 & B2-C1 summaries
 * with separate vocabulary lists, then APPENDS to news.json (archive preserved).
 */

import Anthropic from '@anthropic-ai/sdk';
import Parser from 'rss-parser';
import fs from 'fs/promises';

// ── CONFIG ────────────────────────────────────────────────────────────────────

const ARTICLES_PER_RUN = 12;  // Total articles per weekly edition
const MAX_PER_CATEGORY = 3;   // No single category dominates

const FEEDS = [
  // Politics / EU / Europe
  { url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml',           category: 'politics',     name: 'BBC News Europe' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                  category: 'politics',     name: 'BBC News World' },
  { url: 'https://www.euronews.com/rss',                                  category: 'politics',     name: 'Euronews' },
  { url: 'https://www.politico.eu/feed/',                                 category: 'politics',     name: 'Politico Europe' },
  { url: 'https://notesfrompoland.com/feed/',                             category: 'politics',     name: 'Notes from Poland' },

  // Business / Economy
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',               category: 'business',     name: 'BBC Business' },
  { url: 'https://feeds.reuters.com/reuters/businessNews',                category: 'business',     name: 'Reuters Business' },
  { url: 'https://rss.app/feeds/business-europe.xml',                        category: 'business',     name: 'Business Europe' },
  { url: 'https://www.ft.com/rss/home',                                   category: 'business',     name: 'Financial Times' },

  // Technology
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',             category: 'technology',   name: 'BBC Technology' },
  { url: 'https://feeds.reuters.com/reuters/technologyNews',              category: 'technology',   name: 'Reuters Technology' },
  { url: 'https://www.theguardian.com/technology/rss',                    category: 'technology',   name: 'The Guardian Tech' },

  // Environment / Science
  { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',category: 'environment',  name: 'BBC Science & Environment' },
  { url: 'https://www.theguardian.com/environment/rss',                   category: 'environment',  name: 'The Guardian Environment' },

  // Culture
  { url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', category: 'culture',      name: 'BBC Culture' },
  { url: 'https://www.theguardian.com/culture/rss',                       category: 'culture',      name: 'The Guardian Culture' },
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

  // 3. Load existing archive to build dedup set
  let archive = { editions: [] };
  try {
    const existing = await fs.readFile('news.json', 'utf8');
    archive = JSON.parse(existing);
    if (!archive.editions) {
      archive = { editions: archive.articles ? [{ generated: archive.generated, week: archive.week, articles: archive.articles }] : [] };
    }
  } catch {
    console.log('No existing news.json — starting fresh archive.');
  }

  // Build set of already-seen titles (normalised) to prevent duplicates
  const seenArchiveTitles = new Set();
  for (const edition of archive.editions) {
    for (const art of (edition.articles || [])) {
      seenArchiveTitles.add(normaliseTitle(art.title));
    }
  }
  const dedupedRelevant = relevant.filter(a => !seenArchiveTitles.has(normaliseTitle(a.title)));
  console.log(`🔍  ${relevant.length - dedupedRelevant.length} duplicate(s) removed from archive`);

  // 3. Select a balanced set across categories
  const selected = selectBalanced(dedupedRelevant, ARTICLES_PER_RUN, MAX_PER_CATEGORY);
  console.log(`🎯  Selected ${selected.length} articles for this week`);

  // 4. Generate summaries and vocabulary for each
  const newArticles = [];
  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    console.log(`📝  [${i + 1}/${selected.length}] Summarising: ${item.title}`);
    try {
      const enriched = await summariseArticle(client, item);
      newArticles.push(enriched);
    } catch (err) {
      console.error(`  ⚠️  Failed for "${item.title}": ${err.message}`);
    }
  }

  // 5. Prepend this week's articles to archive
  const thisEdition = {
    generated: new Date().toISOString(),
    week: getISOWeek(),
    articles: newArticles,
  };

  // Prepend newest edition, keep last 12 weeks (~3 months)
  archive.editions = [thisEdition, ...archive.editions].slice(0, 12);

  await fs.writeFile('news.json', JSON.stringify(archive, null, 2), 'utf8');
  console.log(`\n✨  Done! Wrote ${newArticles.length} articles. Archive has ${archive.editions.length} edition(s).`);
}

// ── FEED FETCHING ─────────────────────────────────────────────────────────────

async function fetchAllFeeds(parser) {
  const results = [];
  const seenTitles = new Set();

  await Promise.allSettled(
    FEEDS.map(async (feed) => {
      try {
        const parsed = await parser.parseURL(feed.url);
        for (const item of (parsed.items || []).slice(0, 10)) {
          if (!item.title || !item.link) continue;
          const key = item.title.toLowerCase().trim();
          if (seenTitles.has(key)) continue;
          seenTitles.add(key);
          results.push({
            title: item.title.trim(),
            originalUrl: item.link,
            source: feed.name,
            category: feed.category,
            date: item.pubDate
              ? new Date(item.pubDate).toISOString().split('T')[0]
              : new Date().toISOString().split('T')[0],
            snippet: stripHtml(item.contentSnippet || item.summary || item.content || '').slice(0, 1200),
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
  const BATCH = 10;
  const relevant = [];

  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const list = batch.map((a, idx) =>
      `${idx + 1}. [${a.category.toUpperCase()}] ${a.title}\n   ${a.snippet.slice(0, 200)}`
    ).join('\n\n');

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are curating a weekly English-language news digest for adults living in Poland and Central Europe.

For each article, decide: is it RELEVANT to Polish/Central European readers?
Relevant = affects the EU, European economy, European politics, European culture, technology used in Europe, or major international stories Polish people would care about.
Not relevant = purely local US/UK/Asian stories with no European angle whatsoever.

Reply with ONLY the numbers of relevant articles, comma-separated. Example: 1,3,5,7

Articles:
${list}`
      }]
    });

    const text = msg.content[0]?.text?.trim() || '';
    const indices = text.split(',')
      .map(s => parseInt(s.trim()) - 1)
      .filter(n => n >= 0 && n < batch.length);
    indices.forEach(idx => relevant.push(batch[idx]));

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
URL: ${item.originalUrl}
Category: ${item.category}
Content: ${item.snippet}

Generate a JSON object with EXACTLY these fields (no markdown, no extra text, no code fences):
{
  "summaryB1": "A 180-200 word summary written for B1 (intermediate) English learners. Use clear, direct language with short sentences and common vocabulary. Present the main facts, background context, and why this matters. The 5 B1 vocabulary items must each appear naturally in this summary.",
  "vocabularyB1": [
    { "word": "a word or short phrase used in your B1 summary", "definition": "A simple definition in plain English, max 20 words" },
    { "word": "second item", "definition": "Definition" },
    { "word": "third item", "definition": "Definition" },
    { "word": "fourth item", "definition": "Definition" },
    { "word": "fifth item", "definition": "Definition" }
  ],
  "questionB1": "A single open-ended question (max 25 words) for B1 learners to reflect on the main idea of the article. The question must naturally use 1 or 2 words from vocabularyB1. Make it thought-provoking but accessible.",
  "summaryB2": "A 220-240 word summary written for B2-C1 (upper intermediate to advanced) English learners. Use varied sentence structures and journalistic style. Include nuance, context, implications and multiple perspectives. The 5 B2 vocabulary items must each appear naturally in this summary.",
  "vocabularyB2": [
    { "word": "a more advanced word or phrase used in your B2 summary", "definition": "A clear definition simple enough for a B1 learner, max 20 words" },
    { "word": "second item", "definition": "Definition" },
    { "word": "third item", "definition": "Definition" },
    { "word": "fourth item", "definition": "Definition" },
    { "word": "fifth item", "definition": "Definition" }
  ],
  "questionB2": "A single open-ended question (max 35 words) for B2-C1 learners to think critically about the article. The question must naturally use 1 or 2 words from vocabularyB2. Make it analytically challenging and nuanced."
}

Critical rules:
- Every vocabulary item MUST actually appear verbatim in its respective summary
- The question words MUST appear verbatim in their respective question
- B1 vocabulary: genuinely useful everyday words a B1 learner might not know
- B2 vocabulary: sophisticated journalistic or academic words worth learning
- Do not invent facts not present in the content
- Both summaries must cover the same story at clearly different language levels
- BANNED WORDS AND PHRASES — never use any of these: "important", "importantly", "significant", "significantly", "significant(ly)", "broader", "broader context", "broader implications", "increasingly", "underscores", "raises concerns", "it is worth noting", "it should be noted", "delve", "navigate", "landscape" (when used metaphorically), "realm", "leverage" (as a verb), "foster", "robust", "pivotal", "crucial", "key" (as an adjective meaning important)`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1800,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = msg.content[0]?.text?.trim() || '{}';
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    console.warn('  ⚠️  JSON parse failed, using fallback');
    parsed = {
      summaryB1: item.snippet,
      vocabularyB1: [],
      summaryB2: item.snippet,
      vocabularyB2: [],
    };
  }

  return {
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    title: item.title,
    source: item.source,
    originalUrl: item.originalUrl,
    category: item.category,
    date: item.date,
    summaryB1: parsed.summaryB1 || '',
    vocabularyB1: (parsed.vocabularyB1 || []).slice(0, 5),
    questionB1: parsed.questionB1 || '',
    summaryB2: parsed.summaryB2 || '',
    vocabularyB2: (parsed.vocabularyB2 || []).slice(0, 5),
    questionB2: parsed.questionB2 || '',
  };
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function normaliseTitle(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

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
