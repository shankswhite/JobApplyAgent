#!/usr/bin/env node
//
// scripts/render-cover-letter.mjs
//
// Renders a per-role cover letter PDF from the report's Section G G.1 block.
// The output PDF lives next to the tailored CV PDFs in output/ and follows
// the same naming convention so apply-form.mjs can pick it up automatically.
//
// USAGE:
//   node scripts/render-cover-letter.mjs <report-id-or-slug>
//   node scripts/render-cover-letter.mjs --all
//
// OUTPUT:
//   output/cover-letter-{name-slug}-{render_slug}-{YYYY-MM-DD}.pdf
//
// The candidate's identity (name + contact line) is loaded from
// data/section-g-boilerplate.md (Section 1) — there is no hardcoded
// personal data in this script. The render_slug matches the tailored
// CV's render_slug (resolveRenderConfigSlug) so apply-form.mjs only
// needs to swap "cv-" → "cover-letter-" and look in output/.

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { loadReport, resolveRenderConfigSlug } from './lib/parse-report.mjs';
import { loadBoilerplate } from './lib/parse-boilerplate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(PROJECT_ROOT, 'output');
const TMP_DIR = resolve(PROJECT_ROOT, '.tmp-html');
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

const args = process.argv.slice(2);
const all = args.includes('--all');

if (!all && args.length === 0) {
  console.error('USAGE: node scripts/render-cover-letter.mjs <report-id-or-slug> | --all');
  process.exit(1);
}

// --- markdown → HTML helpers ---

function inlineMd(s) {
  if (!s) return '';
  let out = s;
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/`([^`]+)`/g, '$1');
  return out;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function bodyToParagraphs(body) {
  // Section G cover letter is a quote block, already de-prefixed by parse-report.
  // Split on blank lines → paragraphs. Apply inline markdown.
  if (!body || !body.trim()) return [];
  const blocks = body.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    // Replace single newlines with <br/> within a paragraph.
    const inner = inlineMd(escapeHtml(block).replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
      .replace(/\n/g, '<br/>');
    return `<p>${inner}</p>`;
  });
}

// --- identity helpers ---

function buildContactBits(identity) {
  const bits = [];
  if (identity.location) bits.push(escapeHtml(identity.location));
  if (identity.email) bits.push(escapeHtml(identity.email));
  if (identity.phone) bits.push(escapeHtml(identity.phone));
  if (identity.linkedin) {
    const u = identity.linkedin.startsWith('http') ? identity.linkedin : `https://${identity.linkedin}`;
    const display = identity.linkedin.replace(/^https?:\/\//, '');
    bits.push(`<a href="${escapeHtml(u)}">${escapeHtml(display)}</a>`);
  }
  if (identity.website) {
    const u = identity.website.startsWith('http') ? identity.website : `https://${identity.website}`;
    const display = identity.website.replace(/^https?:\/\//, '');
    bits.push(`<a href="${escapeHtml(u)}">${escapeHtml(display)}</a>`);
  }
  if (identity.github) {
    const u = identity.github.startsWith('http') ? identity.github : `https://${identity.github}`;
    const display = identity.github.replace(/^https?:\/\//, '');
    bits.push(`<a href="${escapeHtml(u)}">${escapeHtml(display)}</a>`);
  }
  return bits.join('\n      &nbsp;·&nbsp; ');
}

function fullDisplayName(identity) {
  const first = identity.preferred_name || identity.first_name;
  return `${first} ${identity.last_name}`.trim();
}

function nameToSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// --- HTML template (single-page Letter, simple pro layout) ---

function renderHtml({ report, today, paragraphs, identity }) {
  const company = report.title.split(/\s*[—-]\s*/).slice(0, 2).join(' — ');
  const fullName = fullDisplayName(identity);
  const contactLine = buildContactBits(identity);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Cover Letter — ${escapeHtml(company)} — ${escapeHtml(fullName)}</title>
<style>
  @page { size: letter; margin: 0.75in 0.85in; }
  html, body {
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 11.5pt;
    color: #1a1a2e;
    line-height: 1.45;
    margin: 0;
    padding: 0;
  }
  .header {
    margin-bottom: 18pt;
    border-bottom: 1px solid #1a1a2e;
    padding-bottom: 10pt;
  }
  .name {
    font-size: 22pt;
    font-weight: 700;
    letter-spacing: 0.4pt;
    margin: 0;
  }
  .contact {
    font-size: 10pt;
    color: #555;
    margin-top: 4pt;
  }
  .contact a { color: #555; text-decoration: none; }
  .meta {
    margin-top: 14pt;
    font-size: 10.5pt;
  }
  .meta .role { font-weight: 600; }
  .meta .date { color: #555; font-size: 10pt; margin-top: 2pt; }
  .body p {
    margin: 0 0 9pt 0;
    text-align: left;
    orphans: 2;
    widows: 2;
  }
  .body p:last-child { margin-bottom: 0; }
  .signoff { margin-top: 12pt; }
  .signoff p { margin: 0; }
  .signoff .name-line {
    font-weight: 700;
    margin-top: 2pt;
  }
  /* Light typographic polish */
  strong { font-weight: 700; }
  em { font-style: italic; }
  a { color: #1a1a2e; text-decoration: underline; }
</style>
</head>
<body>
  <div class="header">
    <h1 class="name">${escapeHtml(fullName)}</h1>
    <div class="contact">
      ${contactLine}
    </div>
  </div>

  <div class="meta">
    <div class="role">Re: ${escapeHtml(report.title)}</div>
    <div class="date">${today}</div>
  </div>

  <div class="body" style="margin-top: 14pt;">
    ${paragraphs.join('\n    ')}
  </div>
</body>
</html>`;
}

// --- per-report render ---

// Loaded once on import — section-g-boilerplate.md is the single source of
// truth for candidate identity. If the user hasn't filled in their copy,
// loadBoilerplate() throws an actionable error.
const BOILERPLATE = loadBoilerplate();
const NAME_SLUG = nameToSlug(fullDisplayName(BOILERPLATE.identity)) || 'candidate';

function renderOne(idOrSlug, { quiet = false } = {}) {
  const report = loadReport(idOrSlug);
  const cl = report.section_g.cover_letter;
  if (!cl || !cl.trim()) {
    if (!quiet) console.error(`✗ #${report.id} ${report.slug} — no Section G G.1 cover letter found, skipping`);
    return null;
  }
  // Skip "reuse from #N" pointers (rare, but we don't follow them).
  if (/^reuse from\b/i.test(cl) || /\bsame as #\d+\b/i.test(cl)) {
    if (!quiet) console.error(`✗ #${report.id} ${report.slug} — cover letter is a "reuse from" pointer, manual draft needed`);
    return null;
  }

  const renderSlug = resolveRenderConfigSlug(report.slug, report.id);
  const today = new Date().toISOString().slice(0, 10);
  const html = renderHtml({
    report,
    today,
    paragraphs: bodyToParagraphs(cl),
    identity: BOILERPLATE.identity,
  });

  const htmlPath = resolve(TMP_DIR, `cover-letter-${NAME_SLUG}-${renderSlug}.html`);
  const pdfPath = resolve(OUT_DIR, `cover-letter-${NAME_SLUG}-${renderSlug}-${today}.pdf`);
  writeFileSync(htmlPath, html);

  execFileSync(process.execPath, [
    resolve(PROJECT_ROOT, 'generate-pdf.mjs'),
    htmlPath,
    pdfPath,
    '--format=letter',
    '--margin=0.75in',
  ], { stdio: 'inherit' });

  if (!quiet) console.log(`✅ #${report.id} ${report.slug} → ${pdfPath.replace(PROJECT_ROOT + '/', '')}`);
  return pdfPath;
}

// --- main ---

if (all) {
  // Iterate over every report file in reports/ that has a cover-letter Section G.
  const reportsDir = resolve(PROJECT_ROOT, 'reports');
  const files = readdirSync(reportsDir).filter(f => /^\d+-.*\.md$/.test(f)).sort();
  let ok = 0, skip = 0;
  for (const f of files) {
    const m = f.match(/^(\d+)-/);
    if (!m) continue;
    try {
      const result = renderOne(m[1]);
      if (result) ok++; else skip++;
    } catch (e) {
      console.error(`✗ ${f}: ${e.message.split('\n')[0]}`);
      skip++;
    }
  }
  console.log(`\n📦 ${ok} cover-letter PDFs rendered, ${skip} skipped.`);
} else {
  renderOne(args[0]);
}
