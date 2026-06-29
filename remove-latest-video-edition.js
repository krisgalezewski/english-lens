/**
 * remove-latest-video-edition.js — one-off script to remove whichever
 * edition is currently first (most recent) in videos.json, regardless
 * of its date. Useful for removing a flawed edition before re-fetching.
 *
 * Run once: node remove-latest-video-edition.js
 */

import fs from 'fs/promises';

async function main() {
  const raw = await fs.readFile('videos.json', 'utf8');
  const archive = JSON.parse(raw);

  if (!archive.editions || !archive.editions.length) {
    console.log('No editions found — nothing to remove.');
    return;
  }

  const removed = archive.editions.shift();
  console.log(`Removed edition generated at ${removed.generated} with ${(removed.videos || []).length} video(s):`);
  removed.videos?.forEach(v => console.log(`  [${v.category}] ${v.title}`));

  await fs.writeFile('videos.json', JSON.stringify(archive, null, 2), 'utf8');
  console.log(`\nDone. ${archive.editions.length} edition(s) remain in the archive.`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
