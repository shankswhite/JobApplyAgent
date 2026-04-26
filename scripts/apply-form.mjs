#!/usr/bin/env node
//
// scripts/apply-form.mjs
//
// Single-role auto-fill — opens a Chromium window, snapshots every form field
// on the page, resolves each from boilerplate / Section G / local cache, and
// fills what it can. Surfaces unanswered fields at the end so the candidate
// (or the agent in chat) can write the missing answers and commit them back
// to the cache for next time.
//
// SAFETY: never clicks Submit. Per CLAUDE.md and modes/_shared.md.
//
// USAGE:
//   node scripts/apply-form.mjs 16
//   node scripts/apply-form.mjs glean-mle-llm-evals
//   node scripts/apply-form.mjs 16 --dry-run        # preview ctx, no browser
//   node scripts/apply-form.mjs 16 --headless       # invisible
//   node scripts/apply-form.mjs 16 --no-upload      # skip resume upload
//   node scripts/apply-form.mjs 16 --keep-open=false
//   node scripts/apply-form.mjs 16 --login          # one-time session capture

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoilerplate } from './lib/parse-boilerplate.mjs';
import { loadReport, resolveTailoredPDF, resolveRenderConfigSlug } from './lib/parse-report.mjs';
import {
  detectPlatform,
  platformRequiresAuth,
  hasAuthState,
  loadAuthOptions,
  saveAuthState,
  waitForEnter,
  authStateSummary,
} from './lib/auth-state.mjs';
import { loadCache } from './lib/answer-cache.mjs';
import { buildContext } from './lib/answer-resolver.mjs';
import { navigateAndFill, findCoverLetterPDF } from './lib/fill-form.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const idOrSlug = args.find(a => !a.startsWith('--'));
const headless = args.includes('--headless');
const skipUpload = args.includes('--no-upload');
const dryRun = args.includes('--dry-run');
const loginMode = args.includes('--login');
const keepOpen = !args.includes('--keep-open=false');

if (!idOrSlug) {
  console.error('USAGE: node scripts/apply-form.mjs <report-id-or-slug> [flags]');
  console.error('FLAGS: --dry-run --headless --no-upload --login --keep-open=false');
  process.exit(1);
}

const boilerplate = loadBoilerplate();
const report = loadReport(idOrSlug);
const cache = loadCache();
const pdfPath = resolveTailoredPDF(report.slug, report.id);
const renderSlug = resolveRenderConfigSlug(report.slug, report.id);
const coverLetterPath = findCoverLetterPDF(renderSlug);

if (!report.url) {
  console.error(`Report ${report.file} has no **URL:** in the header — cannot apply.`);
  process.exit(1);
}

const ctx = buildContext({ boilerplate, report, cache });

const platform = detectPlatform(report.url);
const needsAuth = platformRequiresAuth(platform);
const sessionLoaded = needsAuth && hasAuthState(platform);
const sessionInfo = sessionLoaded ? authStateSummary(platform) : null;

console.log('━'.repeat(72));
console.log(`📋 ${report.title}`);
console.log(`   ID #${report.id}   |   Score: ${report.score}`);
console.log(`🔗 ${report.url}`);
console.log(`🏢 ATS: ${platform}${needsAuth ? (sessionLoaded ? `   |   🔐 session: .auth/${platform}.json (${sessionInfo.cookies} cookies)` : '   |   🔐 LOGIN REQUIRED') : ''}`);
console.log(`📎 ${pdfPath ? pdfPath.replace(PROJECT_ROOT + '/', '') : '(no tailored PDF — generate with: node scripts/render-cv.mjs --config ' + renderSlug + ')'}`);
console.log(`💌 ${coverLetterPath ? coverLetterPath.replace(PROJECT_ROOT + '/', '') : '(no cover-letter PDF — generate with: node scripts/render-cover-letter.mjs ' + report.id + ')'}`);
console.log(`💰 ${ctx.sectionG.salary_single_number}   |   📨 how heard: ${ctx.sectionG.overrides.how_heard || boilerplate.fallback_how_heard}`);
console.log(`❓ Section G custom Q&A: ${ctx.sectionG.custom_qa.length}    |   📚 Cache entries: ${cache.entries.length}`);
if (report.section_g.ad_hoc.length > 0) {
  console.log(`💬 Ad-hoc context (interview prep, not auto-filled):`);
  for (const a of report.section_g.ad_hoc) console.log(`   • G.${a.number} — ${a.header}`);
}
if (report.section_g.form_notes.length > 0) {
  console.log('📝 Form notes (advisory):');
  for (const n of report.section_g.form_notes) console.log(`   • ${n}`);
}
console.log('━'.repeat(72));

if (dryRun) {
  console.log('\n🔍 DRY-RUN — context summary:\n');
  console.log(JSON.stringify({
    identity: ctx.boilerplate.identity,
    section_g: {
      cover_letter: ctx.sectionG.cover_letter ? ctx.sectionG.cover_letter.slice(0, 80) + '…' : null,
      why_company: ctx.sectionG.why_company ? ctx.sectionG.why_company.slice(0, 80) + '…' : null,
      why_role: ctx.sectionG.why_role ? ctx.sectionG.why_role.slice(0, 80) + '…' : null,
      spotlight: ctx.sectionG.spotlight ? ctx.sectionG.spotlight.slice(0, 80) + '…' : null,
      additional_info: ctx.sectionG.additional_info ? ctx.sectionG.additional_info.slice(0, 80) + '…' : null,
      salary: ctx.sectionG.salary_single_number,
      custom_qa_count: ctx.sectionG.custom_qa.length,
    },
    cache_entries: cache.entries.length,
  }, null, 2));
  process.exit(0);
}

if (pdfPath && !skipUpload && !existsSync(pdfPath)) {
  console.error(`Resume PDF missing: ${pdfPath}`);
  process.exit(1);
}

const log = (icon, msg) => console.log(`${icon} ${msg}`);

if (loginMode) {
  if (!needsAuth) {
    console.error(`✗ Platform "${platform}" does not require login.`);
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });
  const page = await context.newPage();
  log('🔐', `LOGIN MODE — platform: ${platform}`);
  log('🌐', `Opening ${report.url}`);
  await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  console.log('━'.repeat(72));
  console.log(`👉 Log in manually in the browser, then come back and press Enter.`);
  console.log('━'.repeat(72));
  await waitForEnter();
  const saved = await saveAuthState(context, platform);
  log('✅', `Session saved → ${saved.replace(PROJECT_ROOT + '/', '')}`);
  await browser.close();
  process.exit(0);
}

if (needsAuth && !sessionLoaded) {
  console.error(`✗ "${platform}" requires authentication but no saved session.`);
  console.error(`  Run: node scripts/apply-form.mjs ${idOrSlug} --login`);
  process.exit(1);
}

const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 50 });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
  ...loadAuthOptions(platform),
});
const page = await context.newPage();

const stats = await navigateAndFill({
  page,
  report,
  pdfPath,
  coverLetterPath,
  skipUpload,
  ctx,
  log,
});

console.log('━'.repeat(72));
log('✅', `Done — scanned ${stats.scanned}, filled ${stats.filled}, uploaded ${stats.uploaded}, failed ${stats.failed}, unanswered ${stats.unanswered.length}   |   ${(stats.durationMs / 1000).toFixed(1)}s`);

if (stats.unanswered.length > 0) {
  console.log('━'.repeat(72));
  console.log(`📝 Fields you still need to answer manually (${stats.unanswered.length}):`);
  for (const f of stats.unanswered) {
    const req = f.required ? ' *' : '';
    const opts = f.options && f.options.length > 0 ? `   options: [${f.options.slice(0, 4).join(' / ')}${f.options.length > 4 ? `, +${f.options.length - 4} more` : ''}]` : '';
    console.log(`   • [${f.type}]${req} ${f.label}${opts}`);
  }
  console.log('  💡 Type answers into the open browser. Tell the agent to commit them to the cache.');
}

console.log('━'.repeat(72));
log('🛡', 'Script will NOT click Submit (per modes/_shared.md).');
log('🔄', `When submitted: update data/applications.md status #${report.id} from \`Evaluated\` → \`Applied\`.`);
console.log('━'.repeat(72));

if (keepOpen) {
  await new Promise(r => browser.on('disconnected', r));
} else {
  await page.waitForTimeout(60000);
  await browser.close();
}
