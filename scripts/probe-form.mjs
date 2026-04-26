#!/usr/bin/env node
//
// scripts/probe-form.mjs
//
// Diagnostic / discovery script for application forms. Opens a URL, optionally
// clicks the "Apply" landing trigger, then for every (filtered) interactive
// field it reports:
//   - the field metadata extract-form-fields produced
//     (label, type, name, id, selector, required, static options)
//   - for combobox fields: the visible role=option texts (server-rendered),
//     both with no typing and after typing an optional prefix.
//   - all "Add another"-style multi-entry buttons on the page.
//
// Useful when:
//   - The auto-fill picked a wrong combobox option and you want to see the
//     full list of canonical choices an ATS exposes (Greenhouse Degree only
//     allows "Master's Degree", not "Master of Science" — easy to discover
//     by running this once).
//   - A form on a new ATS isn't being scanned correctly and you want to
//     compare extracted-fields output against the visual DOM.
//   - You want to know whether a form supports multi-entry education /
//     experience and what the button selector looks like.
//
// Usage:
//   node scripts/probe-form.mjs <url> [options]
//
// Options:
//   --field=<keyword>     Only probe fields whose label/name/id matches this
//                         keyword (regex, case-insensitive). Repeatable.
//   --typed=<prefix>      After opening each combobox, type this prefix and
//                         re-dump the (filtered) options. Useful for async
//                         typeahead fields like Greenhouse School.
//   --type=<combobox|...> Only probe fields of this `type` (one of the types
//                         emitted by extract-form-fields).
//   --no-add-another      Skip the "Add another" button enumeration.
//   --no-apply            Skip clicking the "Apply" landing trigger.
//   --keep-open=<seconds> How long to leave the browser open at the end
//                         (default: 60). Set to 0 to close immediately.
//
// Examples:
//   node scripts/probe-form.mjs https://job-boards.greenhouse.io/.../jobs/123
//   node scripts/probe-form.mjs <url> --field=degree --typed=Master
//   node scripts/probe-form.mjs <url> --type=combobox --typed=A
//   node scripts/probe-form.mjs <url> --field=race --field=gender
//

import { chromium } from 'playwright';
import { extractFormFields } from './lib/extract-form-fields.mjs';

function parseArgs(argv) {
  const args = {
    url: null,
    fields: [],
    typed: null,
    type: null,
    addAnother: true,
    apply: true,
    keepOpen: 60,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--field=')) args.fields.push(arg.slice('--field='.length));
    else if (arg.startsWith('--typed=')) args.typed = arg.slice('--typed='.length);
    else if (arg.startsWith('--type=')) args.type = arg.slice('--type='.length);
    else if (arg === '--no-add-another') args.addAnother = false;
    else if (arg === '--no-apply') args.apply = false;
    else if (arg.startsWith('--keep-open=')) args.keepOpen = parseInt(arg.slice('--keep-open='.length), 10);
    else if (arg === '-h' || arg === '--help') { args.help = true; }
    else if (!args.url && /^https?:/.test(arg)) args.url = arg;
  }
  return args;
}

const args = parseArgs(process.argv);
if (args.help || !args.url) {
  console.error([
    'Usage: node scripts/probe-form.mjs <url> [options]',
    '',
    'Options:',
    '  --field=<keyword>     Only probe matching fields (regex, repeatable)',
    '  --typed=<prefix>      Type prefix into each combobox and re-dump options',
    '  --type=<combobox|...> Only probe fields of this type',
    '  --no-add-another      Skip add-another button enumeration',
    '  --no-apply            Skip clicking the Apply landing trigger',
    '  --keep-open=<sec>     Keep browser open this many seconds (default 60)',
  ].join('\n'));
  process.exit(args.help ? 0 : 1);
}

const fieldRes = args.fields.map(k => new RegExp(k, 'i'));
const matchesFieldFilter = (f) => {
  if (fieldRes.length === 0) return true;
  return fieldRes.some(r =>
    r.test(f.label || '') || r.test(f.name || '') || r.test(f.id || '')
  );
};

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
console.log(`🌐 ${args.url}`);
await page.goto(args.url, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

if (args.apply) {
  const triggers = [
    page.getByRole('button', { name: /^apply( now| for this job)?$/i }),
    page.getByRole('link', { name: /^apply( now| for this job)?$/i }),
    page.getByRole('button', { name: /^apply\b/i }),
    page.getByRole('link', { name: /^apply\b/i }),
  ];
  for (const t of triggers) {
    const first = t.first();
    if ((await first.count()) > 0 && await first.isVisible().catch(() => false)) {
      console.log('🖱  Clicking apply trigger');
      await first.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
      break;
    }
  }
}

await page.evaluate(async () => {
  let prev = -1;
  for (let i = 0; i < 30; i++) {
    if (prev === document.body.scrollHeight) break;
    prev = document.body.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 350));
  }
  window.scrollTo(0, 0);
});
await page.waitForTimeout(500);

console.log('\n━━━ FIELD INVENTORY ━━━');
const allFields = await extractFormFields(page);
let probedFields = allFields;
if (args.type) probedFields = probedFields.filter(f => f.type === args.type);
probedFields = probedFields.filter(matchesFieldFilter);
console.log(`Total fields detected: ${allFields.length}`);
console.log(`Probing: ${probedFields.length}${args.type ? ` (type=${args.type})` : ''}${fieldRes.length > 0 ? ` (filter: ${args.fields.join(', ')})` : ''}`);

const summarise = (opts, header) => {
  console.log(`  ${header}: ${opts.length}`);
  for (const o of opts.slice(0, 25)) console.log(`    - ${JSON.stringify(o.text)}`);
  if (opts.length > 25) console.log(`    ...+${opts.length - 25} more`);
};

const readVisibleOptions = () => page.evaluate(() => {
  return Array.from(document.querySelectorAll('[role="option"]')).map(o => ({
    text: (o.innerText || o.textContent || '').trim(),
    visible: !!(o.offsetWidth || o.offsetHeight),
  })).filter(o => o.visible && o.text);
});

for (const f of probedFields) {
  const label = f.label || '(unlabeled)';
  console.log(`\n--- [${f.type}] "${label}"  required=${!!f.required} ---`);
  console.log(`  name="${f.name || ''}"  id="${f.id || ''}"`);
  console.log(`  selector: ${f.selector}`);
  if (f.placeholder) console.log(`  placeholder: ${JSON.stringify(f.placeholder)}`);
  if (f.options && f.options.length > 0) {
    console.log(`  static options (${f.options.length}): ${JSON.stringify(f.options.slice(0, 12))}${f.options.length > 12 ? ' ...' : ''}`);
  }

  if (f.type !== 'combobox') continue;

  const loc = page.locator(f.selector).first();
  if ((await loc.count()) === 0) {
    console.log('  (selector not found in live DOM, skip)');
    continue;
  }

  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
    await loc.click({ timeout: 3000 });
    await page.waitForTimeout(750);
    let opts = await readVisibleOptions();
    summarise(opts, '[opened, no typing] visible options');

    if (args.typed) {
      await page.keyboard.type(args.typed, { delay: 30 });
      await page.waitForTimeout(1500);
      opts = await readVisibleOptions();
      summarise(opts, `[typed ${JSON.stringify(args.typed)}] visible options`);
    }
  } catch (e) {
    console.log(`  ✗ probe failed: ${e.message.split('\n')[0]}`);
  } finally {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }
}

if (args.addAnother) {
  console.log('\n━━━ ADD-ANOTHER BUTTONS ━━━');
  const buttons = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return all.map(b => ({
      tag: b.tagName.toLowerCase(),
      text: (b.innerText || b.textContent || '').trim().slice(0, 80),
      cls: typeof b.className === 'string' ? b.className.slice(0, 80) : '',
      id: b.id || '',
      visible: !!(b.offsetWidth || b.offsetHeight),
    })).filter(b => b.visible && /^add\b|add another|\+\s*(?:another|education|experience|employment|school|degree|link|reference|language)/i.test(b.text));
  });
  console.log(`Visible add-another-style buttons: ${buttons.length}`);
  for (const b of buttons) console.log(`  <${b.tag}> ${JSON.stringify(b.text)} id="${b.id}" cls="${b.cls}"`);
}

if (args.keepOpen > 0) {
  console.log(`\n(Browser stays open for ${args.keepOpen}s. Ctrl-C to close earlier.)`);
  await page.waitForTimeout(args.keepOpen * 1000);
}
await browser.close();
