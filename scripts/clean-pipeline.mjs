#!/usr/bin/env node
/**
 * clean-pipeline.mjs — Move evaluated URLs from Pendientes → Procesadas in data/pipeline.md
 *
 * Reads URL → report mapping from reports/*.md (each report has **URL:** line + **Score:**).
 * Any pending row whose URL matches a known report is moved to Procesadas with format:
 *   - [x] #NNN | url | company | role | score | PDF ❌
 */
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS = join(ROOT, 'reports');
const PIPELINE = join(ROOT, 'data/pipeline.md');

// Build URL -> {num, score, company, role} map
const urlMap = new Map();
for (const f of readdirSync(REPORTS).filter(x => /^\d{3}-.*\.md$/.test(x))) {
  const text = readFileSync(join(REPORTS, f), 'utf8');
  const num = f.slice(0, 3);
  const url = (text.match(/\*\*URL:\*\*\s*(\S+)/) || [])[1];
  const score = (text.match(/\*\*Score:\*\*\s*([0-9.]+\s*\/\s*5)/) || [])[1];
  const titleMatch = text.match(/^#\s*\d{3}\s*[—–-]\s*(.+?)\s*[—–-]\s*(.+?)\s*$/m);
  if (!url || !titleMatch) continue;
  urlMap.set(url, { num, score: score || '?/5', company: titleMatch[1].trim(), role: titleMatch[2].trim() });
}

const text = readFileSync(PIPELINE, 'utf8');
const lines = text.split('\n');

const out = [];
const moved = [];
let inPendientes = false;
let inProcesadas = false;

for (const line of lines) {
  if (/^##\s+Pendientes\b/i.test(line)) { inPendientes = true; inProcesadas = false; out.push(line); continue; }
  if (/^##\s+Procesadas\b/i.test(line)) { inPendientes = false; inProcesadas = true; out.push(line); continue; }
  if (/^##\s/.test(line))               { inPendientes = false; inProcesadas = false; out.push(line); continue; }

  if (inPendientes) {
    const m = line.match(/^-\s*\[\s*\]\s*(\S+)\s*\|\s*(.+)$/);
    if (m) {
      const url = m[1].trim();
      const hit = urlMap.get(url);
      if (hit) {
        moved.push(`- [x] #${hit.num} | ${url} | ${hit.company} | ${hit.role} | ${hit.score} | PDF ❌`);
        continue; // drop from Pendientes
      }
    }
  }
  out.push(line);
}

// Append moved rows under Procesadas
const idx = out.findIndex(l => /^##\s+Procesadas\b/i.test(l));
if (idx === -1) {
  out.push('', '## Procesadas', '');
}
const procesadasIdx = out.findIndex(l => /^##\s+Procesadas\b/i.test(l));
const insertAt = procesadasIdx + 1;
const head = out.slice(0, insertAt);
const tail = out.slice(insertAt);
const final = [...head, '', ...moved, ...tail].join('\n').replace(/\n{3,}/g, '\n\n');

writeFileSync(PIPELINE, final);
console.log(`Moved ${moved.length} entries to Procesadas.`);
console.log(`Pendientes remaining: ${out.filter(l => /^-\s*\[\s*\]/.test(l)).length}`);
