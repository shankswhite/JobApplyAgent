#!/usr/bin/env node
//
// scripts/scan-form.mjs
//
// Diagnostic / debug runner: opens a URL with Playwright, clicks the "Apply"
// landing button if present, runs the dynamic field extractor, and prints all
// detected fields with type / label / current value / options.
//
// USAGE:
//   node scripts/scan-form.mjs <id-or-slug>          # use a report's URL
//   node scripts/scan-form.mjs https://...           # arbitrary URL
//   node scripts/scan-form.mjs <id> --headless       # invisible
//   node scripts/scan-form.mjs <id> --json           # JSON output (for piping)

import { chromium } from 'playwright';
import { loadReport } from './lib/parse-report.mjs';
import { extractFormFields, summarizeField } from './lib/extract-form-fields.mjs';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
const headless = args.includes('--headless');
const asJson = args.includes('--json');

if (!target) {
  console.error('USAGE: node scripts/scan-form.mjs <id-or-slug-or-url> [--headless] [--json]');
  process.exit(1);
}

const url = target.startsWith('http') ? target : (() => {
  const r = loadReport(target);
  if (!r.url) {
    console.error(`Report ${r.file} has no URL`);
    process.exit(1);
  }
  return r.url;
})();

const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 50 });
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'en-US',
});
const page = await context.newPage();

if (!asJson) console.error(`🌐 Navigating to ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

// Click any "Apply" landing trigger — broader heuristic to also catch Ashby's
// "Apply for this Job" link/button which routes to a sub-page.
const applyTriggers = [
  page.getByRole('button', { name: /^apply( now| for this job)?$/i }),
  page.getByRole('link', { name: /^apply( now| for this job)?$/i }),
  page.locator('a[href*="application"]').filter({ hasText: /apply/i }),
];
for (const trigger of applyTriggers) {
  const first = trigger.first();
  if (await first.count() > 0 && await first.isVisible().catch(() => false)) {
    if (!asJson) console.error(`🖱  Clicking apply trigger`);
    await first.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    break;
  }
}

const fields = await extractFormFields(page);

if (asJson) {
  console.log(JSON.stringify(fields, null, 2));
} else {
  console.log('━'.repeat(80));
  console.log(`📋 ${url}`);
  console.log(`📊 ${fields.length} fields detected`);
  console.log('━'.repeat(80));
  for (const f of fields) console.log(summarizeField(f));
  console.log('━'.repeat(80));
  const byType = {};
  for (const f of fields) byType[f.type] = (byType[f.type] || 0) + 1;
  console.log('By type:', JSON.stringify(byType));
  const required = fields.filter(f => f.required).length;
  const filled = fields.filter(f => f.currentValue).length;
  console.log(`Required: ${required}   |   Already filled: ${filled}`);
  console.log('━'.repeat(80));
  console.log('Browser will stay open 60s so you can inspect manually. Ctrl-C to close.');
  await page.waitForTimeout(60000);
}

await browser.close();
