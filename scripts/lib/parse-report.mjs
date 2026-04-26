// scripts/lib/parse-report.mjs
//
// Parses a reports/{id}-{slug}-{date}.md file into the structured data
// needed to drive scripts/apply-form.mjs:
//
//   { id, slug, file, url, title, score,
//     section_g: {
//       salary_phrasing, salary_single_number,
//       overrides: { website?, how_heard? },
//       cover_letter, why_company, why_role, spotlight, additional_info,
//       custom_qa: [ { question, answer } ],
//       form_notes: [ "..." ]
//     }
//   }
//
// Convention (Section G in each report):
//
//   ## Section G — Application Form Drafts
//
//   > Use with [`data/section-g-boilerplate.md`](...). Tailored PDF: ...
//
//   **Salary expectation:** ... If single-number field: **$215,000**.
//
//   **Form-field overrides:**            ← optional
//   - Website: https://your-portfolio.com
//   - How heard: LinkedIn
//
//   ### G.1 — Cover Letter
//   > paragraph 1
//   >
//   > paragraph 2
//
//   ### G.2 — Why are you interested in {Company}?
//   > ...
//
//   ### G.3 — Why this role specifically?
//   > ...
//
//   ### G.4 — Spotlight project (STAR)
//   > ...
//
//   ### G.5 — Anything else we should know?
//   (Use boilerplate §9.)              ← falls back to boilerplate
//   > optional explicit override
//
//   ### G.6 — Form-specific notes
//   - advisory line 1
//   - advisory line 2
//
//   ### G.7 — Custom form questions    ← NEW: these drive form auto-fill
//   - **Q:** Do you know anyone currently at {Company}?
//     **A:** No
//   - **Q:** What AI tools are you using today?
//     **A:** Multi-paragraph answer here.
//
//       Continued.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const REPORTS_DIR = resolve(PROJECT_ROOT, 'reports');

// --- file resolution ---

export function resolveReportFile(idOrSlug) {
  if (!idOrSlug) throw new Error('Report id or slug required');

  const all = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
  const arg = String(idOrSlug).trim();

  // Exact prefix: "16" or "016" → 016-*.md
  const padded = arg.padStart(3, '0');
  let match = all.find(f => f.startsWith(`${padded}-`));
  if (match) return resolve(REPORTS_DIR, match);

  // Slug substring (case-insensitive)
  match = all.find(f => f.toLowerCase().includes(arg.toLowerCase()));
  if (match) return resolve(REPORTS_DIR, match);

  throw new Error(`No report matches "${idOrSlug}". Looked in ${REPORTS_DIR}.`);
}

// --- helpers ---

function getBlockquote(text) {
  // Collect contiguous "> ..." lines (allow blank lines starting with ">").
  const out = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) out.push(line.replace(/^>\s?/, ''));
    else if (out.length > 0 && line.trim() === '') break;
  }
  return out.join('\n').trim();
}

function splitGSubsections(sectionG) {
  // Walks Section G and returns [{ number, header, body }] for every "### G.N — Header" block.
  // Body is everything between this header and the next "### G.M" or end of Section G.
  const re = /(?:^|\n)###\s+G\.(\d+)\s*[—-]\s*([^\n]+)\n([\s\S]*?)(?=\n###\s+G\.\d+|\n##\s+|$)/g;
  const out = [];
  let m;
  while ((m = re.exec(sectionG)) !== null) {
    out.push({
      number: parseInt(m[1], 10),
      header: m[2].trim(),
      body: m[3].trim(),
    });
  }
  return out;
}

// Classify a subsection header into one of the standard buckets.
function classifyHeader(header) {
  const h = header.toLowerCase();
  if (/cover letter/.test(h)) return 'cover_letter';
  if (/why\b.*\b(?:are you )?interested\s+in/.test(h) || /^why\s+["']?[a-z]/.test(h)) return 'why_company';
  if (/why this role/.test(h) || /^why\b.*\brole\b/.test(h)) return 'why_role';
  if (/spotlight|tell us about|relevant project|star\b/.test(h)) return 'spotlight';
  if (/anything else|additional info|additional information/.test(h)) return 'additional_info';
  if (/form[- ]specific notes|form notes/.test(h)) return 'form_notes';
  if (/custom form questions|custom questions|form questions/.test(h)) return 'custom_qa';
  return null; // ad-hoc subsection (e.g., "Honesty paragraph", "Go question") → context only
}

function parseFormFieldOverrides(text) {
  // Find a "**Form-field overrides:**" block followed by `- Key: Value` lines
  const re = /\*\*Form-field overrides:\*\*\s*\n((?:-\s+[^\n]+\n?)+)/;
  const m = text.match(re);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^-\s+([^:]+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase().replace(/\s+/g, '_');
    out[key] = kv[2].trim();
  }
  return out;
}

function parseSalarySingleNumber(text) {
  // "If single-number field: **$215,000**"
  const m = text.match(/single[- ]number[^*$]*\*?\*?\s*\$?([0-9][0-9,]*)/i);
  if (!m) return '';
  return '$' + m[1].replace(/[^0-9,]/g, '');
}

function parseSalaryPhrasing(text) {
  // The full **Salary expectation:** ... line.
  const m = text.match(/\*\*Salary expectation:\*\*\s*([^\n]+)/);
  return m ? m[1].trim() : '';
}

function parseG7CustomQA(g7) {
  // Format:
  //   - **Q:** question text
  //     **A:** answer line 1
  //     answer line 2
  //
  //     answer paragraph 2
  //
  //   - **Q:** next question
  //     **A:** ...
  if (!g7) return [];
  const out = [];
  // Split on top-level "- **Q:**" markers
  const parts = g7.split(/\n(?=-\s*\*\*Q:\*\*)/);
  for (const part of parts) {
    const qMatch = part.match(/-\s*\*\*Q:\*\*\s*([^\n]+)/);
    if (!qMatch) continue;
    const question = qMatch[1].trim();

    // Everything after the first "**A:**" until end of this part
    const aIdx = part.indexOf('**A:**');
    if (aIdx === -1) continue;
    const aBlock = part.slice(aIdx + '**A:**'.length);

    // Strip the indentation that markdown lists use (2 spaces typical).
    const dedented = aBlock
      .split('\n')
      .map(l => l.replace(/^ {1,4}/, ''))
      .join('\n')
      .trim();

    out.push({ question, answer: dedented });
  }
  return out;
}

function parseG6Notes(g6) {
  if (!g6) return [];
  return g6
    .split('\n')
    .map(l => l.replace(/^-\s+/, '').trim())
    .filter(Boolean);
}

// --- main entry ---

export function loadReport(idOrSlug) {
  const file = resolveReportFile(idOrSlug);
  const md = readFileSync(file, 'utf-8');
  const fname = basename(file, '.md');

  // Parse id + slug from filename: "016-glean-mle-llm-evals-2026-04-08"
  const fm = fname.match(/^(\d+)-(.+)-(\d{4}-\d{2}-\d{2})$/);
  const id = fm ? fm[1] : '';
  const slug = fm ? fm[2] : fname;

  // Header parsing
  const titleM = md.match(/^#\s+([^\n]+)/m);
  const urlM = md.match(/^\*\*URL:\*\*\s*(\S+)/m);
  const scoreM = md.match(/^\*\*Score:\*\*\s*([^\n]+)/m);

  // Find Section G block
  const gM = md.match(/##\s+Section\s+G[\s\S]*?(?=\n##\s+|$)/);
  if (!gM) {
    throw new Error(`Report ${file} has no "## Section G" block`);
  }
  const sectionG = gM[0];

  const overrides = parseFormFieldOverrides(sectionG);
  const subsections = splitGSubsections(sectionG);

  // Bucket each subsection by its semantic header
  const buckets = {
    cover_letter: '',
    why_company: '',
    why_role: '',
    spotlight: '',
    additional_info: '',
    form_notes: [],
    custom_qa: [],
  };
  // Ad-hoc subsections (G.x with non-standard headers like "Go question",
  // "Honesty paragraph") → kept for transparency but NOT auto-filled, since
  // they don't map to a real form label.
  const ad_hoc = [];

  for (const sub of subsections) {
    const kind = classifyHeader(sub.header);
    if (kind === 'cover_letter') buckets.cover_letter = getBlockquote(sub.body);
    else if (kind === 'why_company') buckets.why_company = getBlockquote(sub.body);
    else if (kind === 'why_role') buckets.why_role = getBlockquote(sub.body);
    else if (kind === 'spotlight') buckets.spotlight = getBlockquote(sub.body);
    else if (kind === 'additional_info') buckets.additional_info = getBlockquote(sub.body);
    else if (kind === 'form_notes') buckets.form_notes = parseG6Notes(sub.body);
    else if (kind === 'custom_qa') buckets.custom_qa = parseG7CustomQA(sub.body);
    else ad_hoc.push({ number: sub.number, header: sub.header, body: getBlockquote(sub.body) });
  }

  return {
    id,
    slug,
    file,
    title: titleM ? titleM[1].trim() : '',
    url: urlM ? urlM[1].trim() : '',
    score: scoreM ? scoreM[1].trim() : '',
    section_g: {
      salary_phrasing: parseSalaryPhrasing(sectionG),
      salary_single_number: parseSalarySingleNumber(sectionG),
      overrides,
      ...buckets,
      ad_hoc, // non-standard subsections, displayed in CLI but not auto-filled
    },
  };
}

// --- PDF resolution ---

const JD_CONFIGS_PATH = resolve(PROJECT_ROOT, 'scripts/jd-configs.json');

// Match any tailored CV PDF for this slug, regardless of the candidate's
// name prefix. Convention: `cv-<name-slug>-<role-slug>-<YYYY-MM-DD>.pdf`
// produced by scripts/render-cv.mjs.
function findOutputPDF(slug) {
  const outputDir = resolve(PROJECT_ROOT, 'output');
  if (!existsSync(outputDir)) return null;
  const re = new RegExp(`^cv-[a-z0-9-]+?-${escapeRe(slug)}-\\d{4}-\\d{2}-\\d{2}\\.pdf$`, 'i');
  const candidates = readdirSync(outputDir)
    .filter(f => re.test(f))
    .sort()
    .reverse();
  return candidates.length > 0 ? resolve(outputDir, candidates[0]) : null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolves the tailored PDF for a report, preferring scripts/jd-configs.json
// (authoritative for PDF slug — render-cv uses this) and falling back to the
// report's own filename slug.
export function resolveTailoredPDF(reportSlug, reportId) {
  if (existsSync(JD_CONFIGS_PATH)) {
    try {
      const configs = JSON.parse(readFileSync(JD_CONFIGS_PATH, 'utf-8'));
      const cfg = configs.find(c => c.id === reportId)
        || configs.find(c => c.slug === reportSlug);
      if (cfg && cfg.slug) {
        const pdf = findOutputPDF(cfg.slug);
        if (pdf) return pdf;
      }
    } catch (_) {
      // fall through to filename-slug lookup
    }
  }
  return findOutputPDF(reportSlug);
}

// Returns the render-cv config slug for a report (used by CLI hint when PDF
// is missing — same lookup as resolveTailoredPDF).
export function resolveRenderConfigSlug(reportSlug, reportId) {
  if (existsSync(JD_CONFIGS_PATH)) {
    try {
      const configs = JSON.parse(readFileSync(JD_CONFIGS_PATH, 'utf-8'));
      const cfg = configs.find(c => c.id === reportId)
        || configs.find(c => c.slug === reportSlug);
      if (cfg && cfg.slug) return cfg.slug;
    } catch (_) {}
  }
  return reportSlug;
}
