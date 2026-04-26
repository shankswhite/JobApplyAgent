#!/usr/bin/env node
//
// Targeted debug: dump the .eeoc__question__wrapper HTML to see whether the
// race combobox is in DOM but hidden, or conditionally rendered.

import { chromium } from 'playwright';

const url = process.argv[2] || 'https://job-boards.greenhouse.io/gleanwork/jobs/4424103005';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

const applyBtn = page.getByRole('button', { name: /^apply( now)?$/i }).first();
if (await applyBtn.count() > 0 && await applyBtn.isVisible().catch(() => false)) {
  await applyBtn.click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

await page.evaluate(async () => {
  let prev = -1;
  while (prev !== document.body.scrollHeight) {
    prev = document.body.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 800));
  }
});

const result = await page.evaluate(() => {
  const wrappers = Array.from(document.querySelectorAll('.eeoc__question__wrapper'));
  return wrappers.map((w, i) => ({
    idx: i,
    visible: !!(w.offsetWidth || w.offsetHeight),
    text: (w.innerText || '').trim().slice(0, 300),
    html: w.outerHTML.slice(0, 1500),
    inputs: Array.from(w.querySelectorAll('input, textarea, select, [role="combobox"]')).map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      role: el.getAttribute('role') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      visible: !!(el.offsetWidth || el.offsetHeight),
      cs: getComputedStyle(el).display,
    })),
  }));
});

for (const w of result) {
  console.log('\n━'.repeat(78));
  console.log(`#${w.idx} eeoc__question__wrapper  visible=${w.visible}`);
  console.log(`text: ${w.text}`);
  console.log(`inputs: ${JSON.stringify(w.inputs, null, 2)}`);
  console.log('html:');
  console.log(w.html);
}

console.log('\n(60s open. Ctrl-C to close.)');
await page.waitForTimeout(60000);
await browser.close();
