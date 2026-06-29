/**
 * remove-todays-video-edition.js — one-off script to remove the most recent
 * video edition if it was generated today, so a fresh fetch can run cleanly
 * afterward without leaving a duplicate "today" edition behind.
 *
 * Run once: node remove-todays-video-edition.js
 */

import fs from 'fs/promises';

async function main() {
  const raw = await fs.readFile('videos.json', 'utf8');
  const archive = JSON.parse(raw);

  if (!archive.editions || !archive.editions.length) {
    console.log('No editions found — nothing to remove.');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const latestDate = archive.editions[0].generated.slice(0, 10);

  if (latestDate !== today) {
    console.log(`Latest edition is from ${latestDate}, not today (${today}) — leaving it in place.`);
    return;
  }

  const removed = archive.editions.shift();
  console.log(`Removed edition generated at ${removed.generated} with ${(removed.videos || []).length} video(s):`);
  removed.videos?.forEach(v => console.log(`  [${v.category}] ${v.title}`));

  await fs.writeFile('videos.json', JSON.stringify(archive, null, 2), 'utf8');
  console.log(`\nDone. ${archive.editions.length} edition(s) remain in the archive.`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
