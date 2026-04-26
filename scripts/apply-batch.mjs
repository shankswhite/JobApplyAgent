#!/usr/bin/env node
//
// scripts/apply-batch.mjs
//
// Sequential batch auto-fill — one Chromium window, N tabs, one role per tab.
// Filled in order; tabs stay open at the end so the candidate cmd-1/cmd-2/...
// through them and clicks Submit on each.
//
// SAFETY: never clicks Submit. One Playwright instance.
//
// USAGE:
//   node scripts/apply-batch.mjs --all
//   node scripts/apply-batch.mjs --tier1
//   node scripts/apply-batch.mjs 16 5 44 15
//   node scripts/apply-batch.mjs --all --dry-run
//   node scripts/apply-batch.mjs --all --headless
//   node scripts/apply-batch.mjs --all --no-upload
//   node scripts/apply-batch.mjs --all --yes              # skip confirm prompt
//   node scripts/apply-batch.mjs --all --manifest=path.md # write unanswered manifest

import { chromium } from 'playwright';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoilerplate } from './lib/parse-boilerplate.mjs';
import { loadReport, resolveTailoredPDF, resolveRenderConfigSlug } from './lib/parse-report.mjs';
import {
  detectPlatform,
  platformRequiresAuth,
  hasAuthState,
  loadAuthOptions,
  waitForEnter,
} from './lib/auth-state.mjs';
import { loadCache } from './lib/answer-cache.mjs';
import { buildContext } from './lib/answer-resolver.mjs';
import { navigateAndFill, findCoverLetterPDF } from './lib/fill-form.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const APPLICATIONS_PATH = resolve(PROJECT_ROOT, 'data/applications.md');

const args = process.argv.slice(2);
const flagAll = args.includes('--all');
const flagTier1 = args.includes('--tier1');
const headless = args.includes('--headless');
const skipUpload = args.includes('--no-upload');
const dryRun = args.includes('--dry-run');
const skipPrompt = args.includes('--yes');
const explicitIds = args.filter(a => /^\d+$/.test(a));
const manifestArg = args.find(a => a.startsWith('--manifest='));
const manifestPath = manifestArg
  ? resolve(PROJECT_ROOT, manifestArg.slice('--manifest='.length))
  : resolve(PROJECT_ROOT, `data/unanswered-${new Date().toISOString().slice(0, 10)}.md`);

if (!flagAll && !flagTier1 && explicitIds.length === 0) {
  console.error('USAGE: node scripts/apply-batch.mjs <--all|--tier1|<id> [<id> ...]> [flags]');
  console.error('FLAGS: --all --tier1 --dry-run --headless --no-upload --yes --manifest=path');
  process.exit(1);
}

function parseEvaluatedRows() {
  const md = readFileSync(APPLICATIONS_PATH, 'utf-8');
  const rows = [];
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 10) continue;
    const id = Number.parseInt(cells[1], 10);
    if (Number.isNaN(id)) continue;
    const score = Number.parseFloat(cells[5]);
    const status = cells[6];
    if (status === 'Evaluated') rows.push({ id, score, status });
  }
  return rows;
}

const evaluatedRows = parseEvaluatedRows();

let targetIds;
if (explicitIds.length > 0) targetIds = explicitIds.map(s => Number.parseInt(s, 10));
else if (flagTier1) targetIds = evaluatedRows.filter(r => r.score >= 4.0).map(r => r.id);
else targetIds = evaluatedRows.map(r => r.id);

if (targetIds.length === 0) {
  console.error('No matching roles found. Check applications.md for Evaluated rows.');
  process.exit(1);
}

const boilerplate = loadBoilerplate();
const cache = loadCache();
const queue = [];
const skipped = [];

for (const id of targetIds) {
  let report;
  try { report = loadReport(String(id)); }
  catch (e) { skipped.push({ id, reason: e.message.split('\n')[0] }); continue; }
  if (!report.url) { skipped.push({ id, reason: `no URL in report header` }); continue; }
  const platform = detectPlatform(report.url);
  const needsAuth = platformRequiresAuth(platform);
  const sessionLoaded = needsAuth && hasAuthState(platform);
  if (needsAuth && !sessionLoaded) {
    skipped.push({ id, reason: `${platform} requires login — run: node scripts/apply-form.mjs ${id} --login` });
    continue;
  }
  const pdfPath = resolveTailoredPDF(report.slug, report.id);
  const renderSlug = resolveRenderConfigSlug(report.slug, report.id);
  const pdfMissing = pdfPath && !skipUpload && !existsSync(pdfPath);
  const coverLetterPath = findCoverLetterPDF(renderSlug);
  const ctx = buildContext({ boilerplate, report, cache });
  queue.push({
    id, report, platform, needsAuth, pdfPath, pdfMissing, coverLetterPath, renderSlug, ctx,
    customCount: ctx.sectionG.custom_qa.length,
    score: report.score,
  });
}

console.log('━'.repeat(72));
console.log(`📋 Batch apply — ${queue.length} role${queue.length === 1 ? '' : 's'} queued${skipped.length ? `, ${skipped.length} skipped` : ''}`);
console.log(`   📚 Cache: ${cache.entries.length} learned answer${cache.entries.length === 1 ? '' : 's'}`);
console.log('━'.repeat(72));

const fmtRow = (i, q) => {
  const idStr = String(q.id).padStart(3, '0');
  const title = q.report.title.length > 56 ? q.report.title.slice(0, 55) + '…' : q.report.title;
  const score = q.score ? q.score.padEnd(7, ' ') : '?      ';
  const customStr = q.customCount > 0 ? `❓${q.customCount}` : '   ';
  const ats = q.platform.padEnd(10, ' ');
  const pdfFlag = q.pdfPath ? (q.pdfMissing ? '📎✗' : '📎✓') : '📎—';
  const clFlag = q.coverLetterPath ? '💌✓' : '💌—';
  return ` ${String(i + 1).padStart(2, ' ')}. #${idStr}  ${score}  ${ats}  ${pdfFlag} ${clFlag}  ${customStr}  ${title}`;
};
for (let i = 0; i < queue.length; i++) console.log(fmtRow(i, queue[i]));

if (skipped.length > 0) {
  console.log('\nSkipped:');
  for (const s of skipped) console.log(`  • #${s.id} — ${s.reason}`);
}

console.log('━'.repeat(72));

if (dryRun) {
  console.log('\n🔍 DRY-RUN — re-run without --dry-run to fill.');
  process.exit(0);
}

if (!skipPrompt) {
  console.log('Press Enter to start, Ctrl-C to abort.');
  await waitForEnter();
}

const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 50 });

const platforms = [...new Set(queue.map(q => q.platform))];
const authPlatforms = platforms.filter(p => platformRequiresAuth(p));
let storageStateOpts = {};
if (authPlatforms.length === 1) storageStateOpts = loadAuthOptions(authPlatforms[0]);
else if (authPlatforms.length > 1) {
  console.error(`✗ Batch contains ${authPlatforms.length} different auth platforms. Run separately.`);
  await browser.close();
  process.exit(1);
}

const browserContext = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
  ...storageStateOpts,
});

const results = [];
const batchStartedAt = Date.now();

for (let i = 0; i < queue.length; i++) {
  const q = queue[i];
  const tabNum = i + 1;
  const prefix = `[${tabNum}/${queue.length}] #${String(q.id).padStart(3, '0')}`;
  console.log('\n' + '═'.repeat(72));
  console.log(`${prefix}  ${q.report.title}`);
  console.log('═'.repeat(72));

  const page = await browserContext.newPage();
  const log = (icon, msg) => console.log(`${icon} ${msg}`);

  let stats;
  let error = null;
  try {
    stats = await navigateAndFill({
      page,
      report: q.report,
      pdfPath: q.pdfMissing ? null : q.pdfPath,
      coverLetterPath: q.coverLetterPath,
      skipUpload,
      ctx: q.ctx,
      log,
    });
  } catch (e) {
    error = e;
    stats = { scanned: 0, filled: 0, uploaded: 0, failed: 1, skipped: 0, unanswered: [], durationMs: 0 };
    console.log(`✗ Fatal error: ${e.message.split('\n')[0]}`);
  }

  results.push({ ...q, stats, error, tabNum });
  console.log(`✅ ${prefix} done — scanned ${stats.scanned}, filled ${stats.filled}, uploaded ${stats.uploaded}, unanswered ${stats.unanswered.length}   |   ${(stats.durationMs / 1000).toFixed(1)}s`);
}

const batchElapsedMin = ((Date.now() - batchStartedAt) / 60000).toFixed(1);

console.log('\n' + '━'.repeat(82));
console.log(`✅ Batch complete — ${queue.length} tabs ready for review (${batchElapsedMin}m)`);
console.log('━'.repeat(82));
console.log('Tab │ ID  │ Scan │ Fill │ Up │ Unans │ Status');
console.log('────┼─────┼──────┼──────┼────┼───────┼' + '─'.repeat(50));

const padNum = (n, w) => String(n).padStart(w, ' ');
for (const r of results) {
  const idStr = String(r.id).padStart(3, '0');
  const scan = padNum(r.stats.scanned, 4);
  const fill = padNum(r.stats.filled, 4);
  const up = padNum(r.stats.uploaded, 2);
  const unans = padNum(r.stats.unanswered.length, 5);
  let status;
  if (r.error) status = `❌ ${r.error.message.split('\n')[0].slice(0, 35)}`;
  else if (r.stats.unanswered.length === 0 && r.stats.failed === 0) status = '✅ ready to submit';
  else status = `⚠ ${r.stats.unanswered.length} field${r.stats.unanswered.length === 1 ? '' : 's'} need answer`;
  const title = r.report.title.length > 36 ? r.report.title.slice(0, 35) + '…' : r.report.title;
  console.log(` ${padNum(r.tabNum, 2)} │ ${idStr} │ ${scan} │ ${fill} │ ${up} │ ${unans} │ ${status}  (${title})`);
}

const totalReady = results.filter(r => !r.error && r.stats.unanswered.length === 0 && r.stats.failed === 0).length;

console.log('━'.repeat(82));
console.log(`📊 ${totalReady}/${results.length} tabs ready to submit blind`);
console.log(`🖱  cmd-1 / cmd-2 / ... → review each tab → click Submit yourself.`);
console.log(`🛡  Script will NOT click Submit. Browser stays open until you close it.`);
console.log(`🔄  After each submit: edit data/applications.md → status \`Evaluated\` → \`Applied\`.`);
console.log('━'.repeat(82));

// --- write unanswered manifest ---

const allUnans = results.filter(r => r.stats.unanswered.length > 0);
if (allUnans.length > 0) {
  const lines = [
    `# Unanswered fields — ${new Date().toISOString().slice(0, 10)}`,
    '',
    'Fill in your answer below each question. When done, run:',
    '',
    '```bash',
    'node scripts/learn-answers.mjs ' + manifestPath.replace(PROJECT_ROOT + '/', ''),
    '```',
    '',
    'This appends each Q→A to `data/form-answers-cache.json` so the same',
    'questions auto-fill on future applications. Mark answers per role with',
    '`scope: role` (only for this role) or `scope: cache` (reuse globally).',
    '',
  ];
  for (const r of allUnans) {
    lines.push(`## #${String(r.id).padStart(3, '0')} — ${r.report.title}`);
    lines.push('');
    lines.push(`URL: ${r.report.url}`);
    lines.push(`Tab: ${r.tabNum}`);
    lines.push('');
    for (const f of r.stats.unanswered) {
      const req = f.required ? ' *(required)*' : '';
      const opts = f.options && f.options.length > 0 ? `\n  - Options: ${f.options.slice(0, 6).join(' / ')}${f.options.length > 6 ? ` (+${f.options.length - 6} more)` : ''}` : '';
      lines.push(`### [${f.type}]${req} ${f.label}${opts}`);
      lines.push('');
      lines.push('- scope: cache');
      lines.push('- answer:');
      lines.push('  > ');
      lines.push('');
    }
  }
  writeFileSync(manifestPath, lines.join('\n'));
  console.log(`📝 Unanswered manifest → ${manifestPath.replace(PROJECT_ROOT + '/', '')}`);
  console.log(`   ${allUnans.reduce((s, r) => s + r.stats.unanswered.length, 0)} field${allUnans.reduce((s, r) => s + r.stats.unanswered.length, 0) === 1 ? '' : 's'} across ${allUnans.length} role${allUnans.length === 1 ? '' : 's'}.`);
  console.log('');
}

await new Promise(r => browser.on('disconnected', r));
