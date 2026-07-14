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
const MAX_PER_PUBLISHER = 3;  // No single publisher (grouping all its feeds) dominates the whole edition

const FEEDS = [
  // Politics / EU / Europe
  { url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml',           category: 'politics',     name: 'BBC News Europe',     publisher: 'BBC' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                  category: 'politics',     name: 'BBC News World',      publisher: 'BBC' },
  { url: 'https://www.euronews.com/rss',                                  category: 'politics',     name: 'Euronews',            publisher: 'Euronews' },
  { url: 'https://www.politico.eu/feed/',                                 category: 'politics',     name: 'Politico Europe',     publisher: 'Politico' },
  { url: 'https://notesfrompoland.com/feed/',                             category: 'politics',     name: 'Notes from Poland',   publisher: 'Notes from Poland' },
  { url: 'https://www.economist.com/europe/rss.xml',                      category: 'politics',     name: 'The Economist Europe', publisher: 'The Economist' },
  { url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml',                   category: 'politics',     name: 'WSJ World News',      publisher: 'Wall Street Journal' },

  // Business / Economy
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',               category: 'business',     name: 'BBC Business',        publisher: 'BBC' },
  { url: 'https://feeds.reuters.com/reuters/businessNews',                category: 'business',     name: 'Reuters Business',    publisher: 'Reuters' },
  { url: 'https://www.ft.com/rss/home',                                   category: 'business',     name: 'Financial Times',     publisher: 'Financial Times' },
  { url: 'https://notesfrompoland.com/feed/',                             category: 'business',     name: 'Notes from Poland',   publisher: 'Notes from Poland' },
  { url: 'https://www.economist.com/business/rss.xml',                    category: 'business',     name: 'The Economist Business', publisher: 'The Economist' },
  { url: 'https://www.economist.com/finance-and-economics/rss.xml',       category: 'business',     name: 'The Economist Finance', publisher: 'The Economist' },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',                 category: 'business',     name: 'WSJ Markets',         publisher: 'Wall Street Journal' },

  // Technology
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',             category: 'technology',   name: 'BBC Technology',      publisher: 'BBC' },
  { url: 'https://feeds.reuters.com/reuters/technologyNews',              category: 'technology',   name: 'Reuters Technology',  publisher: 'Reuters' },
  { url: 'https://www.theguardian.com/technology/rss',                    category: 'technology',   name: 'The Guardian Tech',   publisher: 'The Guardian' },
  { url: 'https://www.economist.com/science-and-technology/rss.xml',      category: 'technology',   name: 'The Economist Sci-Tech', publisher: 'The Economist' },

  // Environment & Wellbeing (climate, health, food systems, urban living)
  { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',category: 'environment',  name: 'BBC Science & Environment', publisher: 'BBC' },
  { url: 'https://www.theguardian.com/environment/rss',                   category: 'environment',  name: 'The Guardian Environment',  publisher: 'The Guardian' },
  { url: 'https://www.theguardian.com/lifeandstyle/health-and-wellbeing/rss', category: 'environment', name: 'The Guardian Wellbeing',  publisher: 'The Guardian' },
  { url: 'https://www.theguardian.com/society/food/rss',                  category: 'environment',  name: 'The Guardian Food',   publisher: 'The Guardian' },
  { url: 'https://feeds.bbci.co.uk/news/health/rss.xml',                  category: 'environment',  name: 'BBC Health',          publisher: 'BBC' },

  // Culture & Lifestyle (arts, entertainment, travel, food, society trends)
  { url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', category: 'culture',      name: 'BBC Culture',         publisher: 'BBC' },
  { url: 'https://www.theguardian.com/culture/rss',                       category: 'culture',      name: 'The Guardian Culture', publisher: 'The Guardian' },
  { url: 'https://notesfrompoland.com/feed/',                             category: 'culture',      name: 'Notes from Poland',   publisher: 'Notes from Poland' },
  { url: 'https://www.theguardian.com/travel/rss',                        category: 'culture',      name: 'The Guardian Travel', publisher: 'The Guardian' },
  { url: 'https://www.theguardian.com/lifeandstyle/rss',                  category: 'culture',      name: 'The Guardian Lifestyle', publisher: 'The Guardian' },
];

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🗞  English Lens — starting weekly fetch…');

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const parser = new Parser({ timeout: 10000 });

  // 0. Guard: if an edition was already generated today, skip to avoid double-runs
  try {
    const existing = await fs.readFile('news.json', 'utf8');
    const existingArchive = JSON.parse(existing);
    if (existingArchive.editions && existingArchive.editions.length > 0) {
      const latestDate = existingArchive.editions[0].generated.slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      if (latestDate === today) {
        console.log(`⏭  Already ran today (${today}) — skipping to prevent duplicate edition.`);
        process.exit(0);
      }
    }
  } catch { /* no existing file, continue */ }

  // 1. Fetch all RSS feeds
  const candidates = await fetchAllFeeds(parser);
  console.log(`📥  Fetched ${candidates.length} candidate articles`);

  // 2. Filter for relevance to Polish / Central European readers
  const relevant = await filterRelevant(client, candidates);
  console.log(`✅  ${relevant.length} articles passed relevance filter`);

  // 3b. Correct categories based on actual article content (not RSS section)
  const categoryCorrected = await correctCategories(client, relevant);

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
  const dedupedRelevant = categoryCorrected.filter(a => !seenArchiveTitles.has(normaliseTitle(a.title)));
  console.log(`🔍  ${categoryCorrected.length - dedupedRelevant.length} duplicate(s) removed from archive`);

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
            publisher: feed.publisher || feed.name,
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
Relevant = affects the EU, European economy, European politics, European culture/arts/entertainment/lifestyle/travel/food trends, technology used in Europe, public health/wellbeing/food systems/urban living in Europe, or major international stories Polish people would care about.
Not relevant = purely local US/UK/Asian stories with no European angle whatsoever, OR sport/match results/sport celebrity news of any kind (even if European), OR celebrity gossip with no broader relevance.

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

// ── CATEGORY CORRECTION ───────────────────────────────────────────────────────
// RSS feeds assign categories based on which section of a news site the article
// appeared in, which is often misleading — e.g. a war story in BBC Business,
// a health story in BBC Politics. This step asks Claude to reassign the category
// based on what the article is actually ABOUT, not where it was published.

async function correctCategories(client, articles) {
  const VALID_CATS = ['politics', 'business', 'technology', 'environment', 'culture'];
  const BATCH = 8;
  const corrected = [...articles];

  for (let i = 0; i < corrected.length; i += BATCH) {
    const batch = corrected.slice(i, i + BATCH);
    const list = batch.map((a, idx) =>
      `${idx + 1}. Current category: ${a.category.toUpperCase()}\n   Title: ${a.title}\n   Summary: ${a.snippet.slice(0, 200)}`
    ).join('\n\n');

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `You are categorising news articles for an English-language digest. The five available categories are:
- politics: government, elections, international relations, war, diplomacy, law, crime
- business: economy, markets, companies, finance, trade, employment
- technology: science, tech, AI, health, medicine, environment (when science-focused)
- environment: climate, nature, wildlife, sustainability, energy, weather, wellbeing, food, lifestyle
- culture: arts, entertainment, music, film, travel, books, sport (culture angle), food culture

For each article below, reply with its number and the CORRECT category based on what the article is actually about — not which section of a news website it came from. If the current category is already correct, keep it.

Format: one per line, like: 1:politics  2:business  3:environment

Articles:
${list}`
      }]
    });

    const text = msg.content[0]?.text?.trim() || '';
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^(\d+)\s*:\s*(\w+)/);
      if (!match) continue;
      const idx = parseInt(match[1]) - 1;
      const newCat = match[2].toLowerCase();
      if (idx >= 0 && idx < batch.length && VALID_CATS.includes(newCat)) {
        const globalIdx = i + idx;
        if (corrected[globalIdx].category !== newCat) {
          console.log(`  📋 Recategorised: [${corrected[globalIdx].category}→${newCat}] ${corrected[globalIdx].title.slice(0, 60)}`);
          corrected[globalIdx] = { ...corrected[globalIdx], category: newCat };
        }
      }
    }

    if (i + BATCH < corrected.length) await sleep(500);
  }

  return corrected;
}

// ── ARTICLE SELECTION ─────────────────────────────────────────────────────────

// Extract key topic words from a title for similarity comparison
function topicWords(title) {
  const stopWords = new Set(['the','a','an','in','on','at','to','for','of','and','or','but',
    'is','are','was','were','be','been','has','have','had','will','would','could','should',
    'with','from','by','as','its','it','this','that','new','over','after','how','why',
    'what','who','when','where','says','said','report','reports']);
  return title.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ')
    .filter(w => w.length > 3 && !stopWords.has(w));
}

// Check if two titles share significant topic overlap
function topicsOverlap(titleA, titleB) {
  const wordsA = new Set(topicWords(titleA));
  const wordsB = topicWords(titleB);
  const shared = wordsB.filter(w => wordsA.has(w));
  return shared.length >= 2; // 2+ shared content words = same topic
}

function selectBalanced(articles, total, maxPerCat) {
  const byCat = {};
  for (const a of articles) {
    if (!byCat[a.category]) byCat[a.category] = [];
    byCat[a.category].push(a);
  }

  // Publishers we want to make sure get fair representation even though
  // they may return fewer matching articles than BBC/Reuters on a given week.
  const PRIORITY_PUBLISHERS = new Set(['Notes from Poland', 'The Economist', 'Wall Street Journal']);

  const selected = [];
  const usedPublishers = {}; // track publisher usage counts (grouped across all that publisher's feeds)
  let round = 0;

  while (selected.length < total && round < MAX_PER_CATEGORY) {
    for (const cat of Object.keys(byCat)) {
      if (selected.length >= total) break;

      const selectedInCat = selected.filter(s => s.category === cat);
      const pool = byCat[cat].filter(a => {
        // Topic diversity check within category
        const topicClash = selectedInCat.some(s => topicsOverlap(s.title, a.title));
        if (topicClash) return false;
        // Publisher variety check globally (grouped, not per individual feed)
        const pubCount = usedPublishers[a.publisher] || 0;
        if (pubCount >= MAX_PER_PUBLISHER) return false;
        return true;
      });

      if (!pool.length) continue;

      // On the first pass, prefer an article from an underused priority publisher
      // if one is available, so Notes from Poland / Economist / WSJ aren't crowded
      // out by the larger wire services.
      let pick = pool[0];
      if (round === 0) {
        const priorityPick = pool.find(a => PRIORITY_PUBLISHERS.has(a.publisher));
        if (priorityPick) pick = priorityPick;
      }

      selected.push(pick);
      usedPublishers[pick.publisher] = (usedPublishers[pick.publisher] || 0) + 1;
      byCat[cat] = byCat[cat].filter(a => a !== pick);
    }
    round++;
  }

  console.log('📊  Publisher distribution:', Object.entries(usedPublishers).map(([s,n]) => `${s}(${n})`).join(', '));
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
