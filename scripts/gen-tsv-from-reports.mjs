#!/usr/bin/env node
/**
 * gen-tsv-from-reports.mjs — Build batch/tracker-additions/*.tsv from reports/*.md
 *
 * Idempotent: skips reports that already have a corresponding .tsv.
 * Extracts: num, date, company, role, score, status, notes (one-line summary).
 *
 * Status logic:
 *   - Verification mentions "Closed" / "404" / "no longer exists" → Discarded
 *   - score >= 3.0 → Evaluated
 *   - score <  3.0 → SKIP
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS = join(ROOT, 'reports');
const TSV_DIR = join(ROOT, 'batch/tracker-additions');

const reportFiles = readdirSync(REPORTS).filter(f => /^\d{3}-.*\.md$/.test(f)).sort();

let created = 0, skipped = 0;

for (const file of reportFiles) {
  const num = file.slice(0, 3);
  const slug = file.replace(/\.md$/, '').replace(/^\d{3}-/, '').replace(/-2026-\d{2}-\d{2}$/, '');
  const tsvPath = join(TSV_DIR, `${num}-${slug}.tsv`);

  if (existsSync(tsvPath)) { skipped++; continue; }

  const text = readFileSync(join(REPORTS, file), 'utf8');

  const titleMatch = text.match(/^#\s*\d{3}\s*[—–-]\s*(.+?)\s*[—–-]\s*(.+?)\s*$/m);
  if (!titleMatch) { console.warn(`! cannot parse title for ${file}`); continue; }
  const company = titleMatch[1].trim();
  const role = titleMatch[2].trim();

  const dateMatch = text.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : '2026-04-08';

  const scoreMatch = text.match(/\*\*Score:\*\*\s*([0-9.]+)\s*\/\s*5/);
  const scoreNum = scoreMatch ? parseFloat(scoreMatch[1]) : null;
  const scoreStr = scoreMatch ? `${scoreMatch[1]}/5` : '0/5';

  const verifMatch = text.match(/\*\*Verification:\*\*\s*(.+)$/m);
  const verif = verifMatch ? verifMatch[1].trim().toLowerCase() : '';
  const isDead = /closed|404|no longer exists|removed|filled/.test(verif);

  let status;
  if (isDead) status = 'Discarded';
  else if (scoreNum != null && scoreNum >= 3.0) status = 'Evaluated';
  else status = 'SKIP';

  // notes: prefer first line of Recommendation, then first line of Global rationale
  let notes = '';
  const recMatch = text.match(/##\s*Recommendation\s*\n+([^\n]+)/);
  if (recMatch) notes = recMatch[1].replace(/\*\*/g, '').trim();
  if (!notes) {
    const globalMatch = text.match(/\|\s*\*\*F\s*[—–-]\s*Global\*\*\s*\|\s*\*\*[0-9.]+\*\*\s*\|\s*([^|]+)\|/);
    if (globalMatch) notes = globalMatch[1].trim();
  }
  notes = notes.replace(/[\t\r\n]+/g, ' ').slice(0, 200);

  const row = [
    parseInt(num, 10),
    date,
    company,
    role,
    status,
    scoreStr,
    '❌',
    `[${num}](reports/${file})`,
    notes,
  ].join('\t') + '\n';

  writeFileSync(tsvPath, row);
  created++;
  console.log(`+ ${num} ${company} — ${role} [${status} ${scoreStr}]`);
}

console.log(`\nCreated ${created}, skipped ${skipped} (already existed).`);
