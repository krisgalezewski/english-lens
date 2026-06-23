/**
 * English Lens — Weekly Video Fetcher (Stage 1: comprehension tasks only)
 * Runs alongside fetch-news.js every Monday.
 * Fetches one short news video per category from a pool of trusted YouTube
 * channels, pulls the auto-caption transcript, and generates comprehension
 * tasks (multiple choice, true/false, ordering). Avoids topic overlap with
 * this week's article summaries. Falls back gracefully if no good match.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';

// ── CONFIG ────────────────────────────────────────────────────────────────────

const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const MAX_DURATION_PRIMARY = 5 * 60;       // 5:00 — preferred max length
const MAX_DURATION_FALLBACK = 6 * 60 + 30; // 6:30 — relaxed fallback length

const CATEGORIES = ['politics', 'business', 'technology', 'environment', 'culture'];

// Pool of channels per category (searched in order; first usable match wins)
const CHANNEL_POOL = {
  politics:     ['Euronews', 'DW News', 'BBC News'],
  business:     ['Reuters', 'The Economist', 'Bloomberg Originals', 'Wall Street Journal', 'Financial Times'],
  technology:   ['Reuters', 'The Economist', 'Bloomberg Originals', 'Wall Street Journal'],
  environment:  ['DW News', 'Euronews', 'BBC News'],
  culture:      ['Euronews', 'BBC News', 'DW News'],
};

// Search query hints per category to bias YouTube search toward relevant topics
const SEARCH_HINTS = {
  politics:    'Europe EU politics news',
  business:    'Europe economy business news',
  technology:  'technology AI news',
  environment: 'climate environment Europe news',
  culture:     'culture arts Europe news',
};

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎬 English Lens — starting weekly video fetch…');

  if (!YT_API_KEY) {
    console.error('❌ YOUTUBE_API_KEY is not set. The video fetch cannot run.');
    console.error('   Add it under: GitHub repo → Settings → Secrets and variables → Actions → New repository secret');
    console.error('   Name it exactly: YOUTUBE_API_KEY');
    process.exitCode = 1; // mark the step as failed so it's visible in the Actions log, but don't crash other steps
    return;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Load existing video archive
  let archive = { editions: [] };
  try {
    const existing = await fs.readFile('videos.json', 'utf8');
    archive = JSON.parse(existing);
    if (!archive.editions) archive = { editions: [] };
  } catch {
    console.log('No existing videos.json — starting fresh archive.');
  }

  // Guard against double-runs on the same day (scheduled runs only —
  // manual test runs via workflow_dispatch can always re-run)
  const isManualRun = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if (archive.editions.length > 0 && !isManualRun) {
    const latestDate = archive.editions[0].generated.slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (latestDate === today) {
      console.log(`⏭  Video edition already generated today (${today}) — skipping.`);
      return;
    }
  }

  // Build set of already-used video IDs (for recency fallback step 3)
  const usedVideoIds = new Set();
  for (const ed of archive.editions) {
    for (const v of (ed.videos || [])) usedVideoIds.add(v.videoId);
  }

  // Load this week's article titles to avoid topic overlap (Stage 1 + articles synergy)
  let articleTitles = [];
  try {
    const newsRaw = await fs.readFile('news.json', 'utf8');
    const newsArchive = JSON.parse(newsRaw);
    if (newsArchive.editions && newsArchive.editions[0]) {
      articleTitles = newsArchive.editions[0].articles.map(a => a.title);
    }
  } catch {
    console.log('Could not read news.json for topic comparison — continuing without it.');
  }

  const videos = [];

  for (const category of CATEGORIES) {
    console.log(`\n📂 Category: ${category}`);
    try {
      const video = await findBestVideo(category, articleTitles, usedVideoIds);
      if (!video) {
        console.log(`  ⏭  No suitable video found for ${category} — skipping this category this week.`);
        continue;
      }
      console.log(`  ✅ Selected: "${video.title}" (${video.channel}, ${formatDuration(video.durationSeconds)})`);

      const tasks = await generateComprehensionTasks(client, video, category);
      videos.push({ ...video, category, ...tasks });
      usedVideoIds.add(video.videoId);
    } catch (err) {
      console.error(`  ⚠️  Failed for category ${category}: ${err.message}`);
    }
  }

  if (!videos.length) {
    console.log('\n⚠️  No videos found for any category this week. Skipping video edition.');
    return;
  }

  const thisEdition = {
    generated: new Date().toISOString(),
    videos,
  };

  archive.editions = [thisEdition, ...archive.editions].slice(0, 12); // keep ~12 weeks

  await fs.writeFile('videos.json', JSON.stringify(archive, null, 2), 'utf8');
  console.log(`\n✨ Done! ${videos.length} video(s) added. Archive has ${archive.editions.length} edition(s).`);
}

// ── VIDEO SELECTION (with fallback cascade) ───────────────────────────────────

async function findBestVideo(category, articleTitles, usedVideoIds) {
  const channels = CHANNEL_POOL[category];
  const hint = SEARCH_HINTS[category];

  // Gather candidate videos from all channels in the pool for this category
  const candidates = await searchChannelsForVideos(channels, hint);
  if (!candidates.length) return null;

  // Filter out already-used videos up front (never reuse — except final fallback)
  const neverUsed = candidates.filter(v => !usedVideoIds.has(v.videoId));

  // STEP 0 (primary): topic-distinct + under primary duration + never used
  let pool = neverUsed.filter(v =>
    v.durationSeconds <= MAX_DURATION_PRIMARY &&
    !topicsOverlapAny(v.title, articleTitles)
  );
  if (pool.length) return await enrichWithCaptions(pool, category);

  // STEP 1: drop topic-distinctness requirement (still under primary duration, never used)
  pool = neverUsed.filter(v => v.durationSeconds <= MAX_DURATION_PRIMARY);
  if (pool.length) {
    console.log('  ↳ Relaxed: allowing topic overlap with articles');
    return await enrichWithCaptions(pool, category);
  }

  // STEP 2: relax duration up to 6:30 (still never used)
  pool = neverUsed.filter(v => v.durationSeconds <= MAX_DURATION_FALLBACK);
  if (pool.length) {
    console.log('  ↳ Relaxed: allowing longer videos up to 6:30');
    return await enrichWithCaptions(pool, category);
  }

  // STEP 3: allow older / previously-considered videos not yet in the archive
  pool = candidates.filter(v => !usedVideoIds.has(v.videoId));
  if (pool.length) {
    console.log('  ↳ Relaxed: using older unused video regardless of duration');
    return await enrichWithCaptions(pool, category);
  }

  // Nothing usable at all
  return null;
}

// Try candidates in order until one has usable captions
async function enrichWithCaptions(pool, category) {
  // Prefer shorter videos first within whatever pool we're given
  const sorted = [...pool].sort((a, b) => a.durationSeconds - b.durationSeconds);
  for (const video of sorted) {
    const transcript = await getTranscript(video.videoId);
    if (transcript && transcript.split(' ').length > 50) {
      console.log(`    ✅ Captions OK for "${video.title.slice(0, 50)}" (${transcript.split(' ').length} words)`);
      return { ...video, transcript };
    } else {
      console.log(`    ⏭  No usable captions for "${video.title.slice(0, 50)}" (${video.videoId})`);
    }
  }
  return null;
}

// ── YOUTUBE API ────────────────────────────────────────────────────────────────

async function searchChannelsForVideos(channelNames, searchHint) {
  const allResults = [];

  for (const channelName of channelNames) {
    try {
      const channelId = await resolveChannelId(channelName);
      if (!channelId) {
        console.log(`    ⚠️  Could not resolve channel ID for "${channelName}" — skipping it.`);
        continue;
      }

      const searchUrl = `https://www.googleapis.com/youtube/v3/search?key=${YT_API_KEY}` +
        `&channelId=${channelId}&part=snippet&order=date&type=video&maxResults=8` +
        `&q=${encodeURIComponent(searchHint)}`;

      const res = await fetch(searchUrl);
      const data = await res.json();

      if (data.error) {
        console.log(`    ❌ YouTube API error for "${channelName}": ${data.error.message} (code ${data.error.code})`);
        continue;
      }
      if (!data.items || !data.items.length) {
        console.log(`    ↳ "${channelName}": 0 search results for query "${searchHint}"`);
        continue;
      }

      const videoIds = data.items.map(i => i.id.videoId).filter(Boolean).join(',');
      if (!videoIds) {
        console.log(`    ↳ "${channelName}": search returned items but no usable video IDs`);
        continue;
      }

      // Get duration + better metadata via videos.list
      const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?key=${YT_API_KEY}` +
        `&id=${videoIds}&part=contentDetails,snippet`;
      const detailsRes = await fetch(detailsUrl);
      const detailsData = await detailsRes.json();

      if (detailsData.error) {
        console.log(`    ❌ YouTube API error (videos.list) for "${channelName}": ${detailsData.error.message}`);
        continue;
      }

      console.log(`    ↳ "${channelName}": found ${(detailsData.items || []).length} video(s)`);

      for (const item of (detailsData.items || [])) {
        allResults.push({
          videoId: item.id,
          title: item.snippet.title,
          channel: item.snippet.channelTitle,
          publishedAt: item.snippet.publishedAt,
          thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
          durationSeconds: parseISODuration(item.contentDetails.duration),
        });
      }
    } catch (err) {
      console.warn(`    ⚠️  Channel search failed (${channelName}): ${err.message}`);
    }
  }

  return allResults;
}

// Cache resolved channel IDs across runs within this process
const channelIdCache = {};

async function resolveChannelId(channelName) {
  if (channelIdCache[channelName]) return channelIdCache[channelName];
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?key=${YT_API_KEY}` +
      `&q=${encodeURIComponent(channelName)}&part=snippet&type=channel&maxResults=1`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      console.log(`    ❌ YouTube API error resolving channel "${channelName}": ${data.error.message} (code ${data.error.code})`);
      return null;
    }

    const id = data.items?.[0]?.snippet?.channelId || data.items?.[0]?.id?.channelId;
    if (id) channelIdCache[channelName] = id;
    else console.log(`    ↳ No channel found matching "${channelName}"`);
    return id || null;
  } catch (err) {
    console.log(`    ⚠️  resolveChannelId threw for "${channelName}": ${err.message}`);
    return null;
  }
}

function parseISODuration(iso) {
  // PT#H#M#S → seconds
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const [, h, m, s] = match;
  return (parseInt(h || 0) * 3600) + (parseInt(m || 0) * 60) + parseInt(s || 0);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── TRANSCRIPT FETCHING ────────────────────────────────────────────────────────

async function getTranscript(videoId) {
  // Strategy: first fetch the video's watch page HTML to discover the actual
  // caption track URL (this is more reliable than guessing timedtext params
  // directly, since auto-caption tracks need exact lang/kind values that vary
  // per video). Fall back to a direct timedtext guess if that fails.

  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const pageRes = await fetch(watchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!pageRes.ok) {
      console.log(`      ⚠️  Watch page fetch failed: HTTP ${pageRes.status}`);
      return null;
    }
    const html = await pageRes.text();

    // Find the captionTracks JSON embedded in the page
    const match = html.match(/"captionTracks":(\[.*?\])/);
    if (!match) {
      console.log(`      ⚠️  No captionTracks found in watch page (video may have no captions)`);
      return null;
    }

    let tracks;
    try {
      tracks = JSON.parse(match[1]);
    } catch {
      console.log(`      ⚠️  Failed to parse captionTracks JSON`);
      return null;
    }

    if (!tracks.length) {
      console.log(`      ⚠️  captionTracks array is empty`);
      return null;
    }

    // Prefer an English track; fall back to the first available track
    const track = tracks.find(t => (t.languageCode || '').startsWith('en')) || tracks[0];
    if (!track || !track.baseUrl) {
      console.log(`      ⚠️  No usable caption track URL found`);
      return null;
    }

    // baseUrl comes HTML-escaped (e.g. \u0026 for &) — decode it
    const captionUrl = track.baseUrl.replace(/\\u0026/g, '&');

    const capRes = await fetch(captionUrl + '&fmt=json3');
    if (!capRes.ok) {
      console.log(`      ⚠️  Caption track fetch failed: HTTP ${capRes.status}`);
      return null;
    }
    const data = await capRes.json();
    if (!data.events) {
      console.log(`      ⚠️  Caption track had no events`);
      return null;
    }

    const text = data.events
      .filter(e => e.segs)
      .map(e => e.segs.map(s => s.utf8).join(''))
      .join(' ')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text || null;
  } catch (err) {
    console.log(`      ⚠️  getTranscript threw: ${err.message}`);
    return null;
  }
}

// ── TOPIC OVERLAP CHECK (reused logic from fetch-news.js) ─────────────────────

function topicWords(title) {
  const stopWords = new Set(['the','a','an','in','on','at','to','for','of','and','or','but',
    'is','are','was','were','be','been','has','have','had','will','would','could','should',
    'with','from','by','as','its','it','this','that','new','over','after','how','why',
    'what','who','when','where','says','said','report','reports']);
  return title.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ')
    .filter(w => w.length > 3 && !stopWords.has(w));
}

function topicsOverlapAny(videoTitle, articleTitles) {
  const videoWords = new Set(topicWords(videoTitle));
  return articleTitles.some(title => {
    const shared = topicWords(title).filter(w => videoWords.has(w));
    return shared.length >= 2;
  });
}

// ── COMPREHENSION TASK GENERATION (Stage 1) ───────────────────────────────────

async function generateComprehensionTasks(client, video, category) {
  // Trim transcript to a safe length for the prompt
  const trimmed = video.transcript.split(' ').slice(0, 1200).join(' ');

  const prompt = `You are an expert EFL teacher creating comprehension tasks for Polish English learners (B1-C1) based on a short news video transcript.

Video title: ${video.title}
Channel: ${video.channel}
Category: ${category}
Transcript: ${trimmed}

Generate a JSON object with EXACTLY these fields (no markdown, no code fences):
{
  "summary": "A 2-3 sentence neutral summary of what the video covers, for display above the tasks.",
  "multipleChoice": [
    { "question": "A comprehension question about a specific fact in the video", "options": ["A", "B", "C", "D"], "correctIndex": 0 },
    { "question": "Second question", "options": ["A", "B", "C", "D"], "correctIndex": 0 },
    { "question": "Third question", "options": ["A", "B", "C", "D"], "correctIndex": 0 }
  ],
  "trueFalse": [
    { "statement": "A statement that is clearly true or false based on the transcript", "answer": true },
    { "statement": "Second statement", "answer": false },
    { "statement": "Third statement", "answer": true }
  ],
  "ordering": {
    "instruction": "Put these events from the video in the order they happened or were mentioned",
    "items": ["Event A", "Event B", "Event C", "Event D"]
  }
}

Critical rules:
- All tasks must be answerable strictly from the transcript content — do not invent facts
- multipleChoice: exactly 3 questions, 4 options each, only one correct
- trueFalse: exactly 3 statements, mix of true and false
- ordering: exactly 4 items, listed in the CORRECT chronological/logical order (the frontend will shuffle them for the student)
- Avoid these overused words: "important", "significant", "broader", "increasingly", "underscores"
- Keep language clear and appropriate for B1-C1 learners`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = msg.content[0]?.text?.trim() || '{}';
  const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    console.warn('  ⚠️  JSON parse failed for tasks, using minimal fallback');
    parsed = { summary: '', multipleChoice: [], trueFalse: [], ordering: { instruction: '', items: [] } };
  }

  return parsed;
}

// ── RUN ───────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
