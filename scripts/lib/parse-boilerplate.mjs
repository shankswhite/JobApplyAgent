// scripts/lib/parse-boilerplate.mjs
//
// Parses data/section-g-boilerplate.md into structured fields:
//   { identity, eeo, additional_info, fallback_salary_single_number,
//     fallback_how_heard }
//
// Single-source-of-truth: every field in the file is parsed; nothing is
// hardcoded here. If you change the boilerplate, parsing follows.

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const BOILERPLATE_PATH = resolve(PROJECT_ROOT, 'data/section-g-boilerplate.md');

function parseMarkdownTable(section) {
  const out = {};
  const lines = section.split('\n');
  for (const line of lines) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].replace(/\*\*/g, '').trim();
    if (!key || /^-+$/.test(key) || /^Field$|^Question$/.test(key)) continue;
    out[key] = val;
  }
  return out;
}

// Parses a multi-row Markdown table where the first column is a numeric index
// and the rest are field columns. Returns an array of { col1, col2, ... }
// objects, normalised to lowercased snake_case keys.
function parseMultiRowTable(section) {
  const lines = section.split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const headerCells = lines[0].split('|').slice(1, -1).map(c => c.trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = [];
  for (const line of lines.slice(2)) { // skip header + separator
    const cells = line.split('|').slice(1, -1).map(c => c.replace(/\*\*/g, '').trim());
    if (cells.length === 0 || cells[0] === '' || /^-+$/.test(cells[0])) continue;
    if (!/^\d+$/.test(cells[0])) continue; // first column must be a number
    const row = {};
    for (let i = 0; i < headerCells.length && i < cells.length; i++) {
      row[headerCells[i]] = cells[i];
    }
    rows.push(row);
  }
  return rows;
}

function getSection(md, n) {
  // Returns text of `## n. ...` block (everything until next `## ` or `---`).
  // No `m` flag → `$` means end-of-input (avoids the zero-length match bug).
  const re = new RegExp(
    `(?:^|\\n)##\\s+${n}\\.[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+\\d+\\.|\\n---\\s*\\n|$)`
  );
  const m = md.match(re);
  return m ? m[1].trim() : '';
}

function getBlockquoteText(section) {
  // Collapse leading "> " from each line, drop the rest.
  const lines = section.split('\n').filter(l => l.startsWith('>'));
  return lines.map(l => l.replace(/^>\s?/, '')).join('\n').trim();
}

export function loadBoilerplate(path = BOILERPLATE_PATH) {
  if (!existsSync(path)) {
    throw new Error(`Boilerplate file not found: ${path}`);
  }
  const md = readFileSync(path, 'utf-8');

  const identityRaw = parseMarkdownTable(getSection(md, 1));
  const eeoRaw = parseMarkdownTable(getSection(md, 7));

  // Canonicalise identity keys → script-friendly names
  const identity = {
    first_name: identityRaw['First name'] || '',
    preferred_name: identityRaw['Preferred / common name'] || '',
    last_name: identityRaw['Last name'] || '',
    email: identityRaw['Email'] || '',
    phone: identityRaw['Phone'] || '',
    location: identityRaw['Address / Location'] || '',
    linkedin: identityRaw['LinkedIn'] || '',
    github: identityRaw['GitHub'] || '',
    website: identityRaw['Portfolio / Website'] || '',
    pronouns: identityRaw['Pronouns'] || '',
  };

  // Country derived from location ("..., USA" → "United States")
  if (/USA\.?$/.test(identity.location) || /United States/.test(identity.location)) {
    identity.country = 'United States';
  } else {
    identity.country = '';
  }

  const eeo = {
    gender: eeoRaw['Gender'] || '',
    race: eeoRaw['Race / Ethnicity'] || '',
    veteran: eeoRaw['Veteran status'] || '',
    disability: eeoRaw['Disability status'] || '',
    hispanic: eeoRaw['Hispanic / Latino'] || '',
  };

  // Section 9 = additional info paragraph (blockquote)
  const additional_info = getBlockquoteText(getSection(md, 9));

  // Section 6 default single-number fallback ($140K)
  const sec6 = getSection(md, 6);
  const m140 = sec6.match(/use\s+\*\*\$?([0-9,]+(?:K|k)?)\*\*/);
  const fallback_salary_single_number = m140 ? '$' + m140[1].replace(/k$/i, ',000') : '$140,000';

  // Section 4 default how-heard
  const sec4 = getSection(md, 4);
  const mHow = sec4.match(/Default[^:]*:\s*\*\*([^*]+)\*\*/);
  const fallback_how_heard = mHow ? mHow[1].trim() : 'LinkedIn';

  // Section 11 = multi-entry education list (each row = one degree/school).
  // Used for forms with "+ Add another" where we need to fill more than one
  // education entry. Single-entry forms use educations[0] (the first row).
  const eduRows = parseMultiRowTable(getSection(md, 11));
  const educations = eduRows.map(r => ({
    school: r['school'] || '',
    degree: r['degree'] || '',
    discipline: r['discipline'] || '',
    start_month: r['start_month'] || '',
    start_year: r['start_year'] || '',
    end_month: r['end_month'] || '',
    end_year: r['end_year'] || '',
    gpa: r['gpa'] || '',
  }));

  return {
    identity,
    eeo,
    additional_info,
    fallback_salary_single_number,
    fallback_how_heard,
    educations,
  };
}
