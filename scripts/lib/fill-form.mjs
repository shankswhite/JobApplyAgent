//
// scripts/lib/fill-form.mjs
//
// Snapshot-driven form fill flow. Replaces the old hardcoded-label approach.
//
// Pipeline per role:
//   1. Navigate to the form URL.
//   2. Click any "Apply"-shaped trigger (button or link, Greenhouse + Ashby + Lever).
//   3. extractFormFields(page)  → list of every visible interactive field.
//   4. For each field → resolveAnswer(field, ctx) → answer or null.
//   5. Fill matched fields per field.type. Track unmatched fields as
//      {label, type, options, required} for the end-of-batch manifest.
//   6. Re-extract after fills (optional verification step).
//
// SAFETY: never clicks Submit / Send / Apply (final submit). Per CLAUDE.md.
//

import { existsSync, readdirSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFormFields } from './extract-form-fields.mjs';
import { resolveAnswer } from './answer-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = pathResolve(__dirname, '..', '..');

// Find the most recent cover-letter PDF whose filename embeds the given slug.
// We look for output/cover-letter-{name-slug}-{slug}-{date}.pdf — same naming
// convention as scripts/render-cover-letter.mjs. The candidate's name slug
// is not hardcoded; we accept any sequence of `[a-z0-9-]+`.
export function findCoverLetterPDF(slug) {
  if (!slug) return null;
  const outDir = pathResolve(PROJECT_ROOT, 'output');
  if (!existsSync(outDir)) return null;
  const re = new RegExp(`^cover-letter-[a-z0-9-]+?-${escapeRegex(slug)}-\\d{4}-\\d{2}-\\d{2}\\.pdf$`, 'i');
  const candidates = readdirSync(outDir)
    .filter(f => re.test(f))
    .sort()
    .reverse();
  return candidates.length > 0 ? pathResolve(outDir, candidates[0]) : null;
}

export const truncate = (s, n = 60) => {
  if (!s) return '';
  const str = String(s).replace(/\s+/g, ' ');
  return str.length > n ? str.slice(0, n) + '…' : str;
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- click any Apply landing trigger (button OR link, broader than before) ---

async function clickApplyTrigger(page, log) {
  const triggers = [
    page.getByRole('button', { name: /^apply( now| for this job)?$/i }),
    page.getByRole('link', { name: /^apply( now| for this job)?$/i }),
    page.getByRole('button', { name: /^apply\b/i }),
    page.getByRole('link', { name: /^apply\b/i }),
  ];
  for (const t of triggers) {
    const first = t.first();
    if ((await first.count()) > 0 && await first.isVisible().catch(() => false)) {
      log('🖱', 'Clicking apply landing trigger');
      await first.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

// --- per-type fill primitives ---

async function fillTextField(page, field, value, log) {
  const loc = page.locator(field.selector).first();
  if ((await loc.count()) === 0) {
    log('  ✗', `[${field.label}] selector "${field.selector}" not found`);
    return false;
  }
  await loc.fill(String(value), { timeout: 4000 });
  return true;
}

async function fillSelect(page, field, value, log) {
  const loc = page.locator(field.selector).first();
  if ((await loc.count()) === 0) return false;
  try {
    await loc.selectOption({ label: String(value) }, { timeout: 3000 });
    return true;
  } catch {
    try {
      await loc.selectOption(String(value), { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
}

async function fillCombobox(page, field, value, log) {
  // Greenhouse / Ashby / generic react-select pattern.
  // Greenhouse School/Degree are async typeahead — they hit a server API on
  // each keystroke and only render <option> nodes after the response. We need
  // to (a) type a discriminating prefix, (b) actively wait for an option that
  // matches our value (or any option) to appear, (c) prefer the exact match
  // before falling back to the first listed option.
  const loc = page.locator(field.selector).first();
  if ((await loc.count()) === 0) return false;
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await loc.click({ timeout: 3000 });
    await page.waitForTimeout(250);

    // Type a discriminating prefix. Long enough to narrow the typeahead
    // result set, short enough to leave matching slack for fuzzy server-side
    // matching (e.g. an abbreviated school name → its canonical full form
    // typically requires ≤12 chars to surface the right option).
    const valStr = String(value);
    const typed = valStr.slice(0, Math.max(2, Math.min(valStr.length, 18)));
    await page.keyboard.type(typed, { delay: 30 });

    // Wait actively for an option to appear (typeahead async responses can
    // take 700-1500ms). Poll up to 2.5s for any visible role=option.
    const exactRe = new RegExp(`^${escapeRegex(valStr)}$`, 'i');
    const startsRe = new RegExp(`^${escapeRegex(typed)}`, 'i');
    const containsRe = new RegExp(escapeRegex(typed), 'i');

    const tryClick = async (re) => {
      const opt = page.getByRole('option', { name: re }).first();
      if ((await opt.count()) > 0 && await opt.isVisible().catch(() => false)) {
        await opt.click({ timeout: 2000 });
        return true;
      }
      return false;
    };

    // Poll for ~2.5s for the typeahead options to render and pick the best one.
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (await tryClick(exactRe)) return true;
      await page.waitForTimeout(150);
    }
    if (await tryClick(startsRe)) return true;
    if (await tryClick(containsRe)) return true;

    // Last-ditch: click the first visible option, which on typeahead forms
    // is usually the highest-ranked server match for the typed prefix.
    const anyOpt = page.getByRole('option').first();
    if ((await anyOpt.count()) > 0 && await anyOpt.isVisible().catch(() => false)) {
      await anyOpt.click({ timeout: 2000 });
      return true;
    }

    // Fall back to Enter (commits the typed value if combobox accepts free text).
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    return true;
  } catch (e) {
    return false;
  }
}

async function fillRadioGroup(page, field, value, log) {
  // field.options is the list of visible radio labels.
  const target = field.options.find(o => new RegExp(`^${escapeRegex(value)}$`, 'i').test(o))
    || field.options.find(o => new RegExp(escapeRegex(value), 'i').test(o));
  if (!target) return false;
  // Click the radio whose label/value matches the target.
  const radio = page.locator(`input[type="radio"][name="${field.name}"]`).first();
  // Use label-text click as the safer cross-form approach.
  const labelLoc = page.getByText(target, { exact: false }).first();
  if ((await labelLoc.count()) > 0 && await labelLoc.isVisible().catch(() => false)) {
    await labelLoc.click({ timeout: 2000 }).catch(() => {});
    return true;
  }
  // Fallback: click the first radio (rarely correct, but better than nothing).
  if ((await radio.count()) > 0) {
    await radio.click({ timeout: 2000 }).catch(() => {});
    return true;
  }
  return false;
}

async function fillCheckbox(page, field, value, log) {
  const loc = page.locator(field.selector).first();
  if ((await loc.count()) === 0) return false;
  const truthy = /^(yes|true|1|on)$/i.test(String(value)) || value === true;
  if (truthy) await loc.check({ timeout: 2000 }).catch(() => {});
  else await loc.uncheck({ timeout: 2000 }).catch(() => {});
  return true;
}

async function uploadFile(page, field, filePath, log) {
  // The file input might be hidden behind a visible button, but
  // input[type=file] still accepts setInputFiles directly.
  const loc = page.locator(field.selector).first();
  if ((await loc.count()) === 0) return false;
  try {
    await loc.setInputFiles(filePath, { timeout: 5000 });
    return true;
  } catch (e) {
    log('  ✗', `upload [${field.label}] failed: ${e.message.split('\n')[0]}`);
    return false;
  }
}

async function fillContenteditable(page, field, value, log) {
  const loc = page.locator(field.selector).first();
  if ((await loc.count()) === 0) return false;
  await loc.click().catch(() => {});
  await page.keyboard.type(String(value), { delay: 8 });
  return true;
}

// --- dispatcher ---

async function fillField(page, field, value, log) {
  switch (field.type) {
    case 'text':
    case 'email':
    case 'tel':
    case 'url':
    case 'number':
    case 'search':
    case 'password':
    case 'textarea':
      return fillTextField(page, field, value, log);
    case 'select':
      return fillSelect(page, field, value, log);
    case 'combobox':
      return fillCombobox(page, field, value, log);
    case 'radio_group':
      return fillRadioGroup(page, field, value, log);
    case 'checkbox':
      return fillCheckbox(page, field, value, log);
    case 'contenteditable':
      return fillContenteditable(page, field, value, log);
    case 'file':
      return false; // file uploads handled separately with the resume PDF path
    default:
      return false;
  }
}

// --- main entry: navigate, scan, resolve, fill ---
//
// ctx = { boilerplate, sectionG, cache }  (use buildContext from answer-resolver)

export async function navigateAndFill({
  page,
  report,
  pdfPath,
  coverLetterPath,
  skipUpload = false,
  ctx,
  log = (icon, msg) => console.log(`${icon} ${msg}`),
}) {
  const startedAt = Date.now();
  const stats = {
    scanned: 0,
    filled: 0,
    skipped: 0,
    failed: 0,
    uploaded: 0,
    unanswered: [], // [{label, type, required, options}]
    durationMs: 0,
  };

  log('🌐', `Navigating to ${report.url}`);
  await page.goto(report.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);

  await clickApplyTrigger(page, log);

  log('🔍', 'Scanning form fields');
  let fields = await extractFormFields(page);
  stats.scanned = fields.length;
  log('  ', `${fields.length} fields detected (${fields.filter(f => f.required).length} required)`);

  // Form-shape pre-pass: does the form have a SEPARATE preferred / common /
  // nick / chosen / display name slot? Answer-resolver uses this to decide
  // whether the bare "First Name" question wants legal or public. When in
  // doubt, the default is the public name (identity.preferred_name).
  ctx.hasPreferredNameField = fields.some(f =>
    /preferred|^common.?name|^nick.?name|^chosen.?name|^display.?name|what.*should.*we.*call|what.*do.*you.*go.*by/i.test(f.label || '')
  );
  if (ctx.hasPreferredNameField) {
    log('  ', 'preferred-name field detected → "First Name" will use legal name');
  }

  // Pre-pass: handle file uploads (resume + cover letter).
  // Resume PDF and cover-letter PDF are both auto-uploaded when the form
  // exposes the matching field. Cover letter is skipped silently if no PDF
  // exists in output/ (e.g. roles where Section G G.1 was a "reuse from #N"
  // pointer — see scripts/render-cover-letter.mjs).
  if (!skipUpload) {
    if (pdfPath) {
      const resumeField = fields.find(f =>
        f.type === 'file' && /resume|\bcv\b/i.test(f.label + ' ' + f.name + ' ' + f.id)
      );
      if (resumeField) {
        const ok = await uploadFile(page, resumeField, pdfPath, log);
        if (ok) {
          stats.uploaded++;
          log('  📎', `${resumeField.label}: ${pdfPath.split('/').pop()}`);
        }
        await page.waitForTimeout(1200);
      } else {
        log('  ⚠', 'no resume input found — upload manually if the form requires it');
      }
    }

    const coverLetterField = fields.find(f =>
      f.type === 'file' && /cover.?letter/i.test(f.label + ' ' + f.name + ' ' + f.id)
    );
    if (coverLetterField) {
      if (coverLetterPath) {
        const ok = await uploadFile(page, coverLetterField, coverLetterPath, log);
        if (ok) {
          stats.uploaded++;
          log('  📎', `${coverLetterField.label}: ${coverLetterPath.split('/').pop()}`);
        }
        await page.waitForTimeout(1000);
      } else {
        log('  ⚠', 'cover letter input found but no PDF — run: node scripts/render-cover-letter.mjs ' + (report?.id || '<id>'));
        stats.unanswered.push({
          label: coverLetterField.label,
          type: 'file',
          required: coverLetterField.required,
          options: [],
          reason: 'no-cover-letter-pdf',
        });
      }
    }
  }

  // Cover letter as a free-text field (textarea or contenteditable) — paste
  // the Section G cover letter content if such a field is present and the
  // resolver later defers to it. We pre-handle here so the resolver path is
  // simple, and so we don't need to rerun extraction.
  const coverLetterTextField = fields.find(f =>
    (f.type === 'textarea' || f.type === 'contenteditable' || f.type === 'text') &&
    /^cover\s?letter\b/i.test(f.label || '')
  );
  if (coverLetterTextField && ctx?.sectionG?.cover_letter) {
    try {
      const ok = await fillField(page, coverLetterTextField, ctx.sectionG.cover_letter, log);
      if (ok) {
        stats.filled++;
        log('  ✓', `[${coverLetterTextField.type}] ${coverLetterTextField.label} → ${truncate(ctx.sectionG.cover_letter)}  · section_g.cover_letter`);
        coverLetterTextField._handled = true;
      }
    } catch (_) { /* fall through to main pass */ }
  }

  // Track whether we filled at least one education field on this form. We
  // use this signal to decide whether to attempt the "+ Add another"
  // education flow at all — if the form has no education section, we skip
  // the multi-entry pass entirely instead of dumping phantom
  // "Education 2: school/degree/..." entries into the unanswered manifest.
  let firstPassFilledEducation = false;

  // Main pass: resolve + fill every non-file field.
  for (const f of fields) {
    if (f.type === 'file') continue;
    if (f._handled) continue; // already filled in cover-letter pre-pass
    if (!f.label) {
      stats.unanswered.push({ ...f, reason: 'no-label' });
      continue;
    }
    const result = resolveAnswer(f, ctx);
    if (!result) {
      stats.unanswered.push({ label: f.label, type: f.type, required: f.required, options: f.options || [] });
      continue;
    }
    try {
      const ok = await fillField(page, f, result.answer, log);
      if (ok) {
        stats.filled++;
        if (typeof result.source === 'string' && result.source.startsWith('boilerplate.educations[')) {
          firstPassFilledEducation = true;
        }
        const conf = result.confidence ? ` (conf ${result.confidence.toFixed(2)})` : '';
        log('  ✓', `[${f.type}] ${f.label} → ${truncate(result.answer)}${conf}  · ${result.source}`);
      } else {
        stats.failed++;
        log('  ✗', `[${f.type}] ${f.label} fill failed`);
        stats.unanswered.push({ label: f.label, type: f.type, required: f.required, options: f.options || [], reason: 'fill-failed', proposedAnswer: result.answer });
      }
    } catch (e) {
      stats.failed++;
      log('  ✗', `[${f.type}] ${f.label} threw: ${e.message.split('\n')[0]}`);
      stats.unanswered.push({ label: f.label, type: f.type, required: f.required, options: f.options || [], reason: 'exception', error: e.message });
    }
    await page.waitForTimeout(150);
  }

  // Helper: resolve + fill a single field, mutating stats. Used by both the
  // conditional second pass and the multi-entry "Add another" passes.
  async function fillOne(f, fillCtx, tag = '') {
    if (f.type === 'file') return;
    if (!f.label || f.label === '(unlabeled combobox)') {
      stats.unanswered.push({ label: f.label || '(unlabeled)', type: f.type, required: f.required, options: f.options || [], reason: `${tag || 'pass'}-no-label` });
      return;
    }
    const result = resolveAnswer(f, fillCtx);
    if (!result) {
      stats.unanswered.push({ label: f.label, type: f.type, required: f.required, options: f.options || [], reason: `${tag || 'pass'}-unresolved` });
      return;
    }
    try {
      const ok = await fillField(page, f, result.answer, log);
      if (ok) {
        stats.filled++;
        stats.scanned++;
        const conf = result.confidence ? ` (conf ${result.confidence.toFixed(2)})` : '';
        const suffix = tag ? ` (${tag})` : '';
        log('  ✓', `[${f.type}] ${f.label} → ${truncate(result.answer)}${conf}  · ${result.source}${suffix}`);
      } else {
        stats.failed++;
        stats.unanswered.push({ label: f.label, type: f.type, required: f.required, options: f.options || [], reason: 'fill-failed', proposedAnswer: result.answer });
      }
    } catch (e) {
      stats.failed++;
      stats.unanswered.push({ label: f.label, type: f.type, required: f.required, options: f.options || [], reason: 'exception', error: e.message });
    }
    await page.waitForTimeout(150);
  }

  // --- second pass: handle conditionally-rendered fields ---
  // Many ATS forms reveal additional fields after the user answers earlier
  // questions (e.g. a Race combobox that only appears after Hispanic/Latino
  // is answered, or a visa-type field that only appears after sponsorship
  // is set to Yes). We re-scan and fill anything new — but only fields we
  // genuinely have a confident answer for, so we don't overfill.
  await page.waitForTimeout(800);
  const passTwoFields = await extractFormFields(page);
  const handledSelectors = new Set(fields.map(f => f.selector));
  const newFields = passTwoFields.filter(f => !handledSelectors.has(f.selector));
  if (newFields.length > 0) {
    log('🔁', `Conditional fields revealed: ${newFields.length} (re-resolving)`);
    for (const f of newFields) {
      handledSelectors.add(f.selector);
      await fillOne(f, ctx, 'conditional');
    }
  }

  // --- third pass: multi-entry education ("Add another") ---
  // Greenhouse renders one education block by default. When the candidate
  // has multiple degrees (boilerplate.educations.length > 1), we click
  // "Add another" once per extra entry and fill the freshly-revealed
  // fields against educations[i]. Cross-ATS selector tries the Greenhouse
  // class first, then any visible button labelled "Add another".
  //
  // Skip the entire flow if main pass didn't fill any education field —
  // that means the form has no education section at all. Without this
  // guard, every such form spuriously emits one "Add another not found"
  // warning per extra education entry and pollutes the unanswered manifest.
  const educations = ctx?.boilerplate?.educations || [];
  if (educations.length > 1 && firstPassFilledEducation) {
    for (let eduIndex = 1; eduIndex < educations.length; eduIndex++) {
      const addBtnSelectors = [
        'button.add-another-button',
        'button:has-text("Add another")',
        'a:has-text("Add another")',
      ];
      let clicked = false;
      for (const sel of addBtnSelectors) {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0 && await btn.isVisible().catch(() => false)) {
          log('➕', `Clicking "Add another" for education entry ${eduIndex + 1}/${educations.length}`);
          await btn.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
          await btn.click({ timeout: 3000 }).catch(() => {});
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        log('  ⚠', `couldn't find "Add another" — entry ${eduIndex + 1} skipped (manual fill)`);
        for (const k of Object.keys(educations[eduIndex])) {
          if (educations[eduIndex][k]) {
            stats.unanswered.push({ label: `Education ${eduIndex + 1}: ${k}`, type: 'manual', required: false, options: [], reason: 'add-another-not-found', proposedAnswer: educations[eduIndex][k] });
          }
        }
        break;
      }
      await page.waitForTimeout(900);

      const addedFields = (await extractFormFields(page)).filter(f => !handledSelectors.has(f.selector));
      if (addedFields.length === 0) {
        log('  ⚠', `"Add another" clicked but no new fields detected — skipping entry ${eduIndex + 1}`);
        break;
      }
      log('🔁', `Education entry ${eduIndex + 1}: ${addedFields.length} new fields (eduIndex=${eduIndex})`);
      const entryCtx = { ...ctx, eduIndex };
      for (const f of addedFields) {
        handledSelectors.add(f.selector);
        await fillOne(f, entryCtx, `edu#${eduIndex + 1}`);
      }
    }
  }

  stats.durationMs = Date.now() - startedAt;
  return stats;
}
