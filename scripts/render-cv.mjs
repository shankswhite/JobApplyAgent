#!/usr/bin/env node
/**
 * render-cv.mjs — Tailored CV renderer
 *
 * Parses cv.md + profile.yml + cv-template.html and applies a per-JD config to
 * produce HTML, then invokes generate-pdf.mjs to emit the final PDF.
 *
 * Usage:
 *   node scripts/render-cv.mjs --config <jd-config.json>
 *   node scripts/render-cv.mjs --batch <batch-config.json>
 *
 * Per-JD config schema (one job):
 * {
 *   "id": "005",
 *   "slug": "glean-univ-grad",
 *   "company": "Glean",
 *   "format": "letter",
 *   "summary": "<3-4 line keyword-injected summary>",
 *   "competencies": ["RAG pipeline design", "MLOps + observability", ...],
 *   "project_priority": ["talk-to-data", "ai-blog", "campaign-ml", "trading"]
 * }
 *
 * project_priority slugs come from PROJECT_SLUG_MAP below.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CV_PATH = join(ROOT, 'cv.md');
const PROFILE_PATH = join(ROOT, 'config/profile.yml');
const TEMPLATE_PATH = join(ROOT, 'templates/cv-template.html');
const OUT_DIR = join(ROOT, 'output');
const TMP_DIR = join(ROOT, '.tmp-html');

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

// Optional fallback map: first-words-of-project-title → canonical slug.
// Used when project titles in cv.md don't naturally slugify nicely (e.g.
// "AI-Powered Chatbot for Personal Blog" → keep as 'ai-blog' for stable
// project_priority entries in jd-configs.json). Leave empty to use the
// default `title.toLowerCase().replace(/[^a-z0-9]+/g, '-')` slug for
// every project. Customise for your own CV.
const PROJECT_SLUG_MAP = {
  // 'My Cool Project': 'cool-project',
};

// ---------- Markdown helpers ----------
function readYamlSimple(path) {
  // Tiny YAML reader — supports indented key: value plus 2-deep nesting.
  const text = readFileSync(path, 'utf8');
  const out = {};
  const stack = [{ obj: out, indent: -1 }];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const m = line.match(/^\s*(\S[^:]*?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (val === '') {
      const child = {};
      stack[stack.length - 1].obj[key] = child;
      stack.push({ obj: child, indent });
    } else {
      stack[stack.length - 1].obj[key] = val;
    }
  }
  return out;
}

function inlineMd(s) {
  if (!s) return '';
  // **bold** → <strong>
  let out = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // *em* → <em>
  out = out.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // [text](url) → <a>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // `code` → just keep text (ATS friendly)
  out = out.replace(/`([^`]+)`/g, '$1');
  return out;
}

// ---------- Parse cv.md ----------
function parseCv(text) {
  const sections = {};
  let cur = null;
  let buf = [];
  const flush = () => { if (cur) sections[cur] = buf.join('\n').trim(); buf = []; };
  for (const line of text.split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) { flush(); cur = m[1].trim(); continue; }
    if (cur === null) continue;
    buf.push(line);
  }
  flush();
  return sections;
}

function parseExperience(block) {
  const jobs = [];
  let job = null;
  for (const line of block.split('\n')) {
    const head = line.match(/^###\s+(.+)$/);
    if (head) {
      if (job) jobs.push(job);
      // "Company — Role · Location" form
      const raw = head[1];
      const parts = raw.split(/\s+[—–-]\s+/);
      const company = parts[0]?.trim() || raw;
      let role = '', loc = '';
      if (parts[1]) {
        const sub = parts[1].split('·').map(s => s.trim());
        role = sub[0] || '';
        loc = sub.slice(1).join(' · ');
      }
      job = { company, role, loc, period: '', sub: '', bullets: [] };
      continue;
    }
    if (!job) continue;
    // Match italic span "*period*" optionally followed by "· sub-text"
    const italicMatch = line.trim().match(/^\*([^*]+)\*\s*(?:·\s*(.*))?$/);
    if (italicMatch) {
      job.period = italicMatch[1].trim();
      job.sub = (italicMatch[2] || '').trim();
      continue;
    }
    if (/^-\s+/.test(line)) {
      job.bullets.push(line.replace(/^-\s+/, '').trim());
    }
  }
  if (job) jobs.push(job);
  return jobs;
}

function parseProjects(block) {
  const projects = [];
  const lines = block.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // "**Title**" header line — typically also has period, optional link
    const headMatch = line.match(/^\*\*([^*]+)\*\*(.*)$/);
    if (headMatch) {
      const title = headMatch[1].trim();
      const tail = headMatch[2].trim();
      let link = '', period = '', extra = '';
      const linkM = tail.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkM) link = linkM[2];
      const periodM = tail.match(/\*([^*]+)\*$/);
      if (periodM) period = periodM[1].trim();
      extra = tail.replace(linkM ? linkM[0] : '', '').replace(periodM ? periodM[0] : '', '').replace(/[·\-—–]+/g, ' ').trim();

      // Description lines until next blank line or next ** header
      const descLines = [];
      const bullets = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (/^\*\*[^*]+\*\*/.test(l)) break;
        if (l.trim() === '') { i++; if (i < lines.length && /^\*\*[^*]+\*\*/.test(lines[i])) break; continue; }
        if (/^-\s+/.test(l)) bullets.push(l.replace(/^-\s+/, '').trim());
        else descLines.push(l.trim());
        i++;
      }

      const slug = (() => {
        for (const [k, v] of Object.entries(PROJECT_SLUG_MAP)) {
          if (title.startsWith(k)) return v;
        }
        return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      })();

      projects.push({ title, link, period, extra, descLines, bullets, slug });
      continue;
    }
    i++;
  }
  return projects;
}

function parseSkills(block) {
  // "- **Category:** items"
  const out = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^-\s+\*\*([^:*]+):\*\*\s*(.+)$/);
    if (m) out.push({ category: m[1].trim(), items: m[2].trim() });
  }
  return out;
}

function parseEducation(block) {
  const items = [];
  const lines = block.split('\n').filter(l => l.trim());
  let i = 0;
  while (i < lines.length) {
    const head = lines[i];
    const m = head.match(/^\*\*([^*]+)\*\*\s*[—–-]\s*(.+?)(?:·\s*\*([^*]+)\*)?\s*$/);
    if (m) {
      const org = m[1].trim();
      let title = m[2].trim();
      let year = m[3]?.trim() || '';
      // sometimes period is on second line
      let desc = '';
      if (lines[i + 1] && !lines[i + 1].startsWith('**')) {
        desc = lines[i + 1].trim();
        i++;
      }
      items.push({ org, title, year, desc });
    }
    i++;
  }
  return items;
}

function parseAchievements(block) {
  // bullet list
  return block.split('\n').filter(l => /^-\s+/.test(l)).map(l => l.replace(/^-\s+/, '').trim());
}

// ---------- HTML render helpers ----------
function renderExperience(jobs) {
  return jobs.map(job => `
  <div class="job">
    <div class="job-header">
      <span class="job-company">${inlineMd(job.company)}</span>
      <span class="job-period">${inlineMd(job.period)}</span>
    </div>
    <div class="job-role">${inlineMd(job.role)}${job.loc ? ` · <span class="job-location">${inlineMd(job.loc)}</span>` : ''}${job.sub ? ` · <span class="job-location">${inlineMd(job.sub)}</span>` : ''}</div>
    <ul>
      ${job.bullets.map(b => `<li>${inlineMd(b)}</li>`).join('\n      ')}
    </ul>
  </div>`).join('\n');
}

function renderProjects(projects) {
  // Compact: drop bullets, keep only one-liner description.
  return projects.map(p => {
    const head = `<span class="project-title">${inlineMd(p.title)}</span>${p.link ? ` <a class="project-badge" href="${p.link}">${p.link.replace(/^https?:\/\//, '')}</a>` : ''}${p.period ? ` <span class="job-period">${inlineMd(p.period)}</span>` : ''}`;
    const descText = p.descLines.length ? p.descLines.map(inlineMd).join(' ') : '';
    const desc = descText ? `<div class="project-desc">${descText}</div>` : '';
    return `<div class="project">${head}${desc}</div>`;
  }).join('\n');
}

function renderEducation(items) {
  return items.map(e => `
  <div class="edu-item">
    <div class="edu-header">
      <span class="edu-title">${inlineMd(e.title)} <span class="edu-org">— ${inlineMd(e.org)}</span></span>
      <span class="edu-year">${inlineMd(e.year)}</span>
    </div>
    ${e.desc ? `<div class="edu-desc">${inlineMd(e.desc)}</div>` : ''}
  </div>`).join('\n');
}

function renderCertifications(items) {
  // Render as inline single line: "Item 1 · Item 2 · ..."
  if (!items.length) return '';
  return `<div class="cert-item" style="display:block;line-height:1.45;"><span class="cert-title">${items.map(inlineMd).join(' &nbsp;·&nbsp; ')}</span></div>`;
}

function renderSkills(items) {
  return items.map(s => `<div class="skill-item"><span class="skill-category">${inlineMd(s.category)}:</span> ${inlineMd(s.items)}</div>`).join('\n');
}

function renderCompetencies(list) {
  return list.map(c => `<span class="competency-tag">${inlineMd(c)}</span>`).join('\n      ');
}

// Pull out a section by HTML comment marker. Returns { block, before, after }.
function sliceSection(html, marker, nextMarker) {
  const startTag = `<!-- ${marker} -->`;
  const startIdx = html.indexOf(startTag);
  if (startIdx < 0) return null;
  const endTag = nextMarker ? `<!-- ${nextMarker} -->` : null;
  const endIdx = endTag ? html.indexOf(endTag, startIdx + startTag.length) : -1;
  if (endTag && endIdx < 0) return null;
  const block = endTag ? html.slice(startIdx, endIdx) : html.slice(startIdx);
  return { block, startIdx, endIdx };
}

// Drop SUMMARY block; move EDUCATION block to before WORK EXPERIENCE.
// Also: remove `avoid-break` on SKILLS so it can flow into leftover page-1 space.
function transformSections(html) {
  let out = html;

  // Drop summary section
  const sumStart = out.indexOf('<!-- PROFESSIONAL SUMMARY -->');
  const sumNext = out.indexOf('<!-- CORE COMPETENCIES -->');
  if (sumStart >= 0 && sumNext > sumStart) {
    out = out.slice(0, sumStart) + out.slice(sumNext);
  }

  // Move EDUCATION block to right before WORK EXPERIENCE
  const eduStart = out.indexOf('<!-- EDUCATION -->');
  const eduNext = out.indexOf('<!-- CERTIFICATIONS -->', eduStart);
  if (eduStart >= 0 && eduNext > eduStart) {
    const eduBlock = out.slice(eduStart, eduNext);
    out = out.slice(0, eduStart) + out.slice(eduNext);
    const expStart = out.indexOf('<!-- WORK EXPERIENCE -->');
    if (expStart >= 0) {
      out = out.slice(0, expStart) + eduBlock + out.slice(expStart);
    }
  }

  // Allow SKILLS section to break across pages (so it can use page-1 leftover).
  out = out.replace(
    /<!-- SKILLS -->(\s*)<div class="section avoid-break">/,
    '<!-- SKILLS -->$1<div class="section section-skills">'
  );

  return out;
}

// ---------- Build ----------
// Optional default bullet-point caps per company (tighter pack on older
// roles, looser on the most recent). Override per-JD with
// jdConfig.bullet_caps. Leave empty to use jdConfig.experience_bullets_default
// (defaults to 4) for every role. Customise for your own CV.
const DEFAULT_BULLET_CAPS = {
  // 'Acme Corp': 4,
  // 'Older Co': 2,
};

function companyMatchesCap(companyText, capKey) {
  return companyText.toLowerCase().startsWith(capKey.toLowerCase());
}

function build(jdConfig) {
  const cv = readFileSync(CV_PATH, 'utf8');
  const profile = readYamlSimple(PROFILE_PATH);
  const tpl = readFileSync(TEMPLATE_PATH, 'utf8');

  const sections = parseCv(cv);

  let jobs = parseExperience(sections['Experience'] || '');
  const projects = parseProjects(sections['Projects'] || '');
  let skills = parseSkills(sections['Skills'] || '');
  let education = parseEducation(sections['Education'] || '');
  const achievements = parseAchievements(sections['Achievements'] || '');

  // Filter experience: drop companies in `experience_skip`
  const skipSet = new Set((jdConfig.experience_skip || []).map(s => s.toLowerCase()));
  jobs = jobs.filter(j => {
    for (const skip of skipSet) if (j.company.toLowerCase().includes(skip)) return false;
    return true;
  });

  // Filter skills: drop categories in `skills_skip`
  const skillSkipSet = new Set((jdConfig.skills_skip || []).map(s => s.toLowerCase()));
  if (skillSkipSet.size) {
    skills = skills.filter(s => !skillSkipSet.has(s.category.toLowerCase()));
  }

  // Override coursework per JD: jdConfig.course_overrides is an array of
  //   { match: "regex-fragment", courses: ["..."] }
  // entries. The first entry whose case-insensitive regex matches an
  // education org rewrites that entry's desc to a Coursework line. Lets a
  // tailored CV foreground different courses per role without editing cv.md.
  const courseOverrides = jdConfig.course_overrides || [];
  if (courseOverrides.length) {
    education = education.map(e => {
      const orgLower = (e.org || '').toLowerCase();
      for (const ov of courseOverrides) {
        if (!ov || !ov.match || !Array.isArray(ov.courses)) continue;
        const re = new RegExp(ov.match, 'i');
        if (re.test(orgLower)) {
          return { ...e, desc: `Coursework: ${ov.courses.map(c => `**${c}**`).join(' · ')}` };
        }
      }
      return e;
    });
  }

  // Cap bullets per role
  const bulletCaps = { ...DEFAULT_BULLET_CAPS, ...(jdConfig.bullet_caps || {}) };
  jobs = jobs.map(j => {
    let cap = jdConfig.experience_bullets_default || 4;
    for (const [k, v] of Object.entries(bulletCaps)) {
      if (companyMatchesCap(j.company, k)) { cap = v; break; }
    }
    return { ...j, bullets: j.bullets.slice(0, cap) };
  });

  // Filter / order projects per priority
  const orderedProjects = [];
  if (jdConfig.project_priority?.length) {
    for (const slug of jdConfig.project_priority) {
      const p = projects.find(x => x.slug === slug);
      if (p) orderedProjects.push(p);
    }
  } else {
    orderedProjects.push(...projects.slice(0, 4));
  }

  const cand = profile.candidate || profile;
  const name = cand.preferred_name || cand.full_name || 'Candidate';

  const html = tpl
    .replace(/{{LANG}}/g, 'en')
    .replace(/{{PAGE_WIDTH}}/g, jdConfig.format === 'a4' ? '210mm' : '8.5in')
    .replace(/{{NAME}}/g, name)
    .replace(/{{PHONE}}/g, cand.phone || '')
    .replace(/{{EMAIL}}/g, cand.email || '')
    .replace(/{{LINKEDIN_URL}}/g, `https://${cand.linkedin || ''}`)
    .replace(/{{LINKEDIN_DISPLAY}}/g, cand.linkedin || '')
    .replace(/{{PORTFOLIO_URL}}/g, cand.portfolio_url || '')
    .replace(/{{PORTFOLIO_DISPLAY}}/g, (cand.portfolio_url || '').replace(/^https?:\/\//, ''))
    .replace(/{{LOCATION}}/g, cand.location || '')
    .replace(/{{SECTION_SUMMARY}}/g, 'Professional Summary')
    .replace(/{{SUMMARY_TEXT}}/g, inlineMd(jdConfig.summary || sections['Summary'] || ''))
    .replace(/{{SECTION_COMPETENCIES}}/g, 'Core Competencies')
    .replace(/{{COMPETENCIES}}/g, renderCompetencies(jdConfig.competencies || []))
    .replace(/{{SECTION_EXPERIENCE}}/g, 'Work Experience')
    .replace(/{{EXPERIENCE}}/g, renderExperience(jobs))
    .replace(/{{SECTION_PROJECTS}}/g, 'Projects')
    .replace(/{{PROJECTS}}/g, renderProjects(orderedProjects))
    .replace(/{{SECTION_EDUCATION}}/g, 'Education')
    .replace(/{{EDUCATION}}/g, renderEducation(education))
    .replace(/{{SECTION_CERTIFICATIONS}}/g, 'Achievements & Certifications')
    .replace(/{{CERTIFICATIONS}}/g, renderCertifications(achievements))
    .replace(/{{SECTION_SKILLS}}/g, 'Skills')
    .replace(/{{SKILLS}}/g, renderSkills(skills));

  // Make font URLs resolve relative to the template directory (which has fonts/).
  const fontsAbs = `file://${join(ROOT, 'templates/fonts')}`;
  let finalHtml = html.replace(/url\('\.\/fonts\//g, `url('${fontsAbs}/`);

  // Drop the Summary section entirely + reorder Education before Experience for
  // new-grad framing (school + GPA recruited eyes first).
  finalHtml = transformSections(finalHtml);

  // Tighten layout to target 1 page.
  // Target body ≈ 9.5pt (12.67px). Role >= Company per industry convention.
  const tightenCSS = `
  body, html { font-size: 12.0px; line-height: 1.27; }              /* ~9.0pt body */
  .header { margin-bottom: 4px; }
  .header h1 { font-size: 23px; margin-bottom: 2px; }                /* ~17pt name */
  .header-gradient { margin-bottom: 3px; }
  .contact-row { font-size: 10.5px; gap: 4px 11px; }
  .section { margin-bottom: 3px; }
  .section-title { margin-bottom: 2px; padding-bottom: 1px; font-size: 13.3px; } /* ~10pt SECTION */
  .job { margin-bottom: 4px; }
  .job ul { margin-top: 1px; padding-left: 15px; }
  .job li { line-height: 1.26; margin-bottom: 0; font-size: 12.0px; }  /* 9pt bullets */
  .job-header { margin-bottom: 0; gap: 10px; }
  .job-role { margin-bottom: 0; font-size: 13.2px; font-weight: 700; color: #1a1a2e; } /* ~9.9pt role */
  .job-company { font-size: 12.5px; font-weight: 600; }                /* ~9.4pt — smaller than role */
  .job-period { font-size: 10.8px; }
  .project { margin-bottom: 3px; }
  .project-title { font-size: 12.4px; }                                /* ~9.3pt */
  .project-desc { line-height: 1.26; margin-top: 0; font-size: 12.0px; }
  .edu-item { margin-bottom: 2px; }
  .edu-title { font-size: 12.0px; }
  .edu-desc { line-height: 1.26; font-size: 11.2px; }                  /* ~8.4pt */
  .edu-year { font-size: 11.2px; }
  .cert-item { margin-bottom: 0; }
  .cert-title { font-size: 9.6px; line-height: 1.18; }
  .skill-item { margin-bottom: 0; font-size: 10px; line-height: 1.18; } /* ~7.5pt — keywords list */
  .skill-category { font-size: 10px; }
  /* Skills section can flow / break across pages */
  .section-skills, .section-skills * { break-inside: auto !important; page-break-inside: auto !important; }
  .competencies-grid { gap: 4px; margin-top: 1px; }
  .competency-tag { padding: 2px 7px; font-size: 10.5px; }
  .summary-text { display: none; }
  `;
  finalHtml = finalHtml.replace('</style>', tightenCSS + '\n</style>');

  const date = new Date().toISOString().slice(0, 10);
  const candSlug = (cand.preferred_name || cand.full_name || 'cv').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const htmlPath = join(TMP_DIR, `cv-${candSlug}-${jdConfig.slug}.html`);
  const pdfPath = join(OUT_DIR, `cv-${candSlug}-${jdConfig.slug}-${date}.pdf`);

  writeFileSync(htmlPath, finalHtml);

  execFileSync(process.execPath, [
    join(ROOT, 'generate-pdf.mjs'),
    htmlPath,
    pdfPath,
    `--format=${jdConfig.format || 'letter'}`,
    `--margin=${jdConfig.margin || '0.25in'}`,
  ], { stdio: 'inherit' });

  return pdfPath;
}

// ---------- CLI ----------
function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--config');
  const batchIdx = args.indexOf('--batch');
  if (idx >= 0) {
    const cfg = JSON.parse(readFileSync(args[idx + 1], 'utf8'));
    const out = build(cfg);
    console.log(`✅ ${out}`);
  } else if (batchIdx >= 0) {
    const arr = JSON.parse(readFileSync(args[batchIdx + 1], 'utf8'));
    for (const cfg of arr) {
      console.log(`\n→ Building ${cfg.id} ${cfg.company} — ${cfg.slug}`);
      const out = build(cfg);
      console.log(`✅ ${out}`);
    }
  } else {
    console.error('Usage: node scripts/render-cv.mjs --config <file.json>  |  --batch <file.json>');
    process.exit(1);
  }
}

main();
