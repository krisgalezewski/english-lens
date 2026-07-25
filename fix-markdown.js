/**
 * fix-markdown.js — one-off script to remove **bold** and *italic*
 * markdown markers from all text fields in news.json.
 *
 * Run once: node fix-markdown.js
 */

import fs from 'fs/promises';

function stripMarkdown(text) {
  if (!text) return text;
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
}

async function main() {
  const raw = await fs.readFile('news.json', 'utf8');
  const archive = JSON.parse(raw);
  let fixed = 0;

  for (const ed of archive.editions) {
    for (const a of (ed.articles || [])) {
      for (const field of ['summaryB1', 'summaryB2', 'questionB1', 'questionB2']) {
        const original = a[field] || '';
        const cleaned = stripMarkdown(original);
        if (cleaned !== original) {
          a[field] = cleaned;
          fixed++;
          console.log(`Fixed [${field}] in: ${a.title.slice(0, 60)}`);
        }
      }
      for (const vlist of ['vocabularyB1', 'vocabularyB2']) {
        for (const v of (a[vlist] || [])) {
          for (const key of ['word', 'definition']) {
            const original = v[key] || '';
            const cleaned = stripMarkdown(original);
            if (cleaned !== original) {
              v[key] = cleaned;
              fixed++;
              console.log(`Fixed [${vlist}.${key}]: ${original.slice(0, 50)}`);
            }
          }
        }
      }
    }
  }

  await fs.writeFile('news.json', JSON.stringify(archive, null, 2), 'utf8');
  console.log(`\nDone. ${fixed} field(s) cleaned.`);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
