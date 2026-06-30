/**
 * merge-todays-video-editions.js — one-off script to merge multiple
 * same-day video editions into a single edition (by category, newest wins),
 * for cases where the old skip-guard allowed duplicate same-day editions
 * to accumulate before the merge-logic fix was in place.
 *
 * Run once: node merge-todays-video-editions.js
 */

import fs from 'fs/promises';

async function main() {
  const raw = await fs.readFile('videos.json', 'utf8');
  const archive = JSON.parse(raw);

  if (!archive.editions || archive.editions.length < 2) {
    console.log('Fewer than 2 editions — nothing to merge.');
    return;
  }

  // Group editions by date (YYYY-MM-DD)
  const byDate = new Map();
  for (const ed of archive.editions) {
    const date = ed.generated.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(ed);
  }

  const mergedEditions = [];
  for (const [date, eds] of byDate) {
    if (eds.length === 1) {
      mergedEditions.push(eds[0]);
      continue;
    }
    // Multiple editions same day — merge by category, LATER edition wins per category
    // (editions are already newest-first within the original array order at this date)
    const sorted = [...eds].sort((a, b) => new Date(b.generated) - new Date(a.generated));
    const merged = [];
    for (const ed of sorted) {
      for (const v of (ed.videos || [])) {
        if (!merged.find(m => m.category === v.category)) merged.push(v);
      }
    }
    console.log(`Merged ${eds.length} editions from ${date} into one with ${merged.length} video(s): ${merged.map(v => v.category).join(', ')}`);
    mergedEditions.push({ generated: sorted[0].generated, videos: merged });
  }

  // Re-sort newest first
  mergedEditions.sort((a, b) => new Date(b.generated) - new Date(a.generated));
  archive.editions = mergedEditions;

  await fs.writeFile('videos.json', JSON.stringify(archive, null, 2), 'utf8');
  console.log(`\nDone. ${archive.editions.length} edition(s) remain.`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
