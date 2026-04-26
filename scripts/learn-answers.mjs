#!/usr/bin/env node
//
// scripts/learn-answers.mjs
//
// Reads an unanswered-fields manifest produced by apply-batch.mjs (or hand-
// written), parses each Q→A pair, and appends them to the local answer cache
// at data/form-answers-cache.json.
//
// Manifest format (markdown):
//   ### [text]* Question label here
//   - scope: cache         # or `role` to scope to a single application only
//   - answer:
//     > free-text answer body. May span multiple lines, prefixed with `>`.
//
// USAGE:
//   node scripts/learn-answers.mjs data/unanswered-2026-04-26.md
//   node scripts/learn-answers.mjs data/unanswered-2026-04-26.md --dry-run

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache, saveCache, upsertCacheEntry } from './lib/answer-cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const manifestArg = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!manifestArg) {
  console.error('USAGE: node scripts/learn-answers.mjs <manifest.md> [--dry-run]');
  process.exit(1);
}

const manifestPath = resolve(PROJECT_ROOT, manifestArg);
if (!existsSync(manifestPath)) {
  console.error(`✗ Manifest not found: ${manifestPath}`);
  process.exit(1);
}

const md = readFileSync(manifestPath, 'utf-8');

// Parse blocks of the form:
//   ### [<type>]* <question>
//   ...
//   - scope: cache
//   - answer:
//     > line 1
//     > line 2
//   <blank line or next ### or ##>

const lines = md.split('\n');
const records = [];
let cur = null;
let inAnswer = false;
let answerLines = [];

const FIELD_HEADER_RE = /^###\s+\[([^\]]+)\][^\s]*\s+(.+?)\s*$/;
const SCOPE_RE = /^- *scope:\s*(cache|role)/i;
const ANSWER_RE = /^- *answer:/i;
const QUOTE_RE = /^\s*>\s?(.*)/;

for (const line of lines) {
  if (FIELD_HEADER_RE.test(line)) {
    if (cur && answerLines.length > 0) {
      cur.answer = answerLines.join('\n').replace(/\s+$/, '').trim();
      records.push(cur);
    }
    const m = line.match(FIELD_HEADER_RE);
    cur = { type: m[1].trim(), question: m[2].replace(/\s*\*\s*\(required\)\s*$/, '').trim(), scope: 'cache', answer: '' };
    inAnswer = false;
    answerLines = [];
    continue;
  }
  if (!cur) continue;
  if (SCOPE_RE.test(line)) {
    const m = line.match(SCOPE_RE);
    cur.scope = m[1].toLowerCase();
    continue;
  }
  if (ANSWER_RE.test(line)) {
    inAnswer = true;
    answerLines = [];
    continue;
  }
  if (inAnswer) {
    if (QUOTE_RE.test(line)) {
      const m = line.match(QUOTE_RE);
      answerLines.push(m[1]);
    } else if (line.trim() === '' && answerLines.length > 0 && answerLines[answerLines.length - 1] !== '') {
      answerLines.push('');
    } else if (line.startsWith('#') || line.startsWith('---')) {
      inAnswer = false;
    }
  }
}
if (cur && answerLines.length > 0) {
  cur.answer = answerLines.join('\n').replace(/\s+$/, '').trim();
  records.push(cur);
}

const valid = records.filter(r => r.answer && r.scope === 'cache');
const skipped = records.filter(r => !r.answer || r.scope !== 'cache');

console.log('━'.repeat(72));
console.log(`📥 Parsed ${records.length} entries from ${manifestPath.replace(PROJECT_ROOT + '/', '')}`);
console.log(`   ✓ ${valid.length} ready to commit to cache`);
console.log(`   • ${skipped.length} skipped (empty answer or scope=role)`);
console.log('━'.repeat(72));
for (const r of valid) {
  const preview = r.answer.replace(/\s+/g, ' ').slice(0, 60) + (r.answer.length > 60 ? '…' : '');
  console.log(`  + [${r.type}] ${r.question.slice(0, 60)}${r.question.length > 60 ? '…' : ''} → ${preview}`);
}
if (skipped.length > 0) {
  console.log('\n  Skipped:');
  for (const r of skipped) console.log(`  • ${r.question.slice(0, 70)}${r.question.length > 70 ? '…' : ''}  (${r.scope || 'no answer'})`);
}
console.log('━'.repeat(72));

if (dryRun) {
  console.log('🔍 DRY-RUN — nothing written. Re-run without --dry-run to commit.');
  process.exit(0);
}

if (valid.length === 0) {
  console.log('⚠ Nothing to commit.');
  process.exit(0);
}

const cache = loadCache();
for (const r of valid) {
  upsertCacheEntry(cache, {
    question_pattern: r.question,
    answer: r.answer,
    source: `manifest:${manifestArg.split('/').pop()}`,
  });
}
saveCache(cache);
console.log(`✅ Cache updated → ${valid.length} entries committed.`);
console.log(`📚 Total cache size: ${cache.entries.length} entries.`);
