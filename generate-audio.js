/**
 * English Lens — Vocabulary pronunciation audio
 *
 * Walks every edition in news.json and makes sure each vocabulary item
 * (B1 and B2–C1) has an MP3 generated with Google Cloud Text-to-Speech.
 * Files live in audio/words/<slug>.mp3 and are shared across articles,
 * so a word is only ever synthesised once. The relative path is written
 * back into news.json as `audio`, which the page plays with <audio>
 * (works on every phone, unlike the browser's speechSynthesis).
 *
 * Runs in the weekly GitHub Action right after fetch-news.js.
 * Needs env GOOGLE_TTS_API_KEY (a Google Cloud API key restricted to the
 * Cloud Text-to-Speech API). Safe to re-run: existing files are reused.
 *
 *   node generate-audio.js            # generate what's missing
 *   node generate-audio.js --dry-run  # just report what would be generated
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';

// ── CONFIG ────────────────────────────────────────────────────────────────────

// Same British voice as the lessons and English Games, so the whole site sounds consistent.
const VOICE = {
  languageCode: 'en-GB',
  name: process.env.TTS_VOICE || 'en-GB-Neural2-C',
};
// Same settings as the lessons (krisgalezewski.github.io/_audio/generate_audio.py)
const AUDIO_CONFIG = {
  audioEncoding: 'MP3',
  speakingRate: 0.95,
};
const AUDIO_DIR = 'audio/words';
const CONCURRENCY = 4;

const DRY_RUN = process.argv.includes('--dry-run');
const API_KEY = process.env.GOOGLE_TTS_API_KEY;

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const archive = JSON.parse(await fs.readFile('news.json', 'utf8'));
  await fs.mkdir(AUDIO_DIR, { recursive: true });

  // Collect every vocabulary item, grouped by the file it maps to
  const bySlug = new Map(); // slug -> { text, items: [] }
  for (const edition of archive.editions || []) {
    for (const article of edition.articles || []) {
      for (const key of ['vocabularyB1', 'vocabularyB2']) {
        for (const v of article[key] || []) {
          const text = cleanText(v.word);
          const slug = slugify(text);
          if (!slug) continue;
          if (!bySlug.has(slug)) bySlug.set(slug, { text, items: [] });
          bySlug.get(slug).items.push(v);
        }
      }
    }
  }

  const missing = [...bySlug.entries()].filter(([slug]) => !existsSync(fileFor(slug)));
  console.log(`🔊  ${bySlug.size} unique words, ${missing.length} need audio`);

  if (DRY_RUN) {
    missing.slice(0, 50).forEach(([slug, { text }]) => console.log(`   · ${text}  →  ${fileFor(slug)}`));
    return;
  }

  if (missing.length && !API_KEY) {
    console.warn('⚠️  GOOGLE_TTS_API_KEY is not set — skipping audio generation. The page will fall back to browser speech for these words.');
  } else {
    let done = 0, failed = 0;
    await runPool(missing, CONCURRENCY, async ([slug, { text }]) => {
      try {
        const mp3 = await synthesise(text);
        await fs.writeFile(fileFor(slug), mp3);
        done++;
      } catch (err) {
        failed++;
        console.warn(`  ⚠️  "${text}": ${err.message}`);
      }
    });
    console.log(`✅  Generated ${done} file(s)${failed ? `, ${failed} failed (will retry next run)` : ''}`);
  }

  // Point every vocab item at its file (only if the file really exists)
  let linked = 0;
  for (const [slug, { items }] of bySlug) {
    const path = fileFor(slug);
    const has = existsSync(path);
    for (const v of items) {
      if (has) { v.audio = path; linked++; }
      else delete v.audio;
    }
  }

  await fs.writeFile('news.json', JSON.stringify(archive, null, 2), 'utf8');
  console.log(`✨  ${linked} vocabulary item(s) linked to audio in news.json`);
}

// ── GOOGLE TTS ────────────────────────────────────────────────────────────────

async function synthesise(text, attempt = 1) {
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { text }, voice: VOICE, audioConfig: AUDIO_CONFIG }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return synthesise(text, attempt + 1);
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const { audioContent } = await res.json();
  if (!audioContent) throw new Error('empty audioContent');
  return Buffer.from(audioContent, 'base64');
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function cleanText(word) {
  return String(word || '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function fileFor(slug) {
  return `${AUDIO_DIR}/${slug}.mp3`;
}

async function runPool(items, size, worker) {
  let i = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  });
  await Promise.all(lanes);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
