#!/usr/bin/env node
/**
 * mark-pdf-generated.mjs — flip PDF column ❌ → ✅ for given report numbers.
 *
 * Usage: node scripts/mark-pdf-generated.mjs 005 016 044 ...
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APPS = join(ROOT, 'data/applications.md');
const ids = process.argv.slice(2).map(s => parseInt(s, 10));
if (!ids.length) { console.error('Usage: node scripts/mark-pdf-generated.mjs <id> [<id> ...]'); process.exit(1); }

const text = readFileSync(APPS, 'utf8');
const lines = text.split('\n');
let changed = 0;
const out = lines.map(line => {
  const m = line.match(/^\|\s*(\d+)\s*\|/);
  if (!m) return line;
  if (!ids.includes(parseInt(m[1], 10))) return line;
  if (!line.includes('❌')) return line;
  changed++;
  return line.replace('❌', '✅');
});
writeFileSync(APPS, out.join('\n'));
console.log(`Updated ${changed} rows.`);
