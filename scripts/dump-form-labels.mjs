#!/usr/bin/env node

// scripts/dump-form-labels.mjs
//
// Quick diagnostic: opens a Greenhouse / Ashby URL, lists every form field
// and its associated label so we can update the auto-fill config.
//
// USAGE: node scripts/dump-form-labels.mjs <url>

import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) {
  console.error('USAGE: node scripts/dump-form-labels.mjs <url>');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

// click "Apply" if present
const applyBtn = page.getByRole('button', { name: /^apply( now)?$/i }).first();
if (await applyBtn.count() > 0 && await applyBtn.isVisible().catch(() => false)) {
  await applyBtn.click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

const fields = await page.evaluate(() => {
  const out = [];
  const elements = Array.from(document.querySelectorAll('input, textarea, select'));
  for (const el of elements) {
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;

    let label = '';
    if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl) label = lbl.textContent.trim().replace(/\s+/g, ' ');
    }
    if (!label) {
      const parent = el.closest('label');
      if (parent) label = parent.textContent.trim().replace(/\s+/g, ' ');
    }
    if (!label) {
      const aria = el.getAttribute('aria-label');
      if (aria) label = aria;
    }
    if (!label) {
      const aria = el.getAttribute('aria-labelledby');
      if (aria) {
        const ref = document.getElementById(aria);
        if (ref) label = ref.textContent.trim().replace(/\s+/g, ' ');
      }
    }
    // Greenhouse pattern: label is a sibling div with class 'application--label' or just preceding text
    if (!label) {
      const wrapper = el.closest('[class*="field"], [class*="question"], div');
      if (wrapper) {
        const lbl = wrapper.querySelector('label, [class*="label"]');
        if (lbl) label = lbl.textContent.trim().replace(/\s+/g, ' ');
      }
    }

    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      label: (label || '').slice(0, 140),
      required: el.required || el.getAttribute('aria-required') === 'true',
    });
  }
  return out;
});

console.log(`\n📋 ${fields.length} form fields on ${url}\n`);
for (const f of fields) {
  const tag = `${f.tag}${f.type ? `[${f.type}]` : ''}`.padEnd(16);
  const req = f.required ? '*' : ' ';
  console.log(`${req} ${tag} | label: "${f.label}"`);
  if (f.name) console.log(`  ${' '.repeat(16)}   name="${f.name}"`);
  if (f.placeholder) console.log(`  ${' '.repeat(16)}   placeholder="${f.placeholder}"`);
}

await browser.close();
