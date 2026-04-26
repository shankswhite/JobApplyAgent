//
// scripts/lib/answer-cache.mjs
//
// Persistent local cache of "I've answered this question before — here's the
// answer". Used by the resolver as a fallback after boilerplate / Section G
// matches fail. Grows organically as the candidate (or the agent) provides
// answers during apply sessions.
//
// File: data/form-answers-cache.json
// Format:
//   {
//     "version": 1,
//     "entries": [
//       { "question_pattern": "...", "answer": "...", "answer_combobox": "...",
//         "source": "...", "learned_at": "..." },
//       ...
//     ]
//   }

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = resolve(__dirname, '../../data/form-answers-cache.json');

export function loadCache(path = CACHE_PATH) {
  if (!existsSync(path)) {
    return { version: 1, entries: [] };
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(data.entries)) data.entries = [];
    return data;
  } catch (e) {
    console.warn(`⚠ Failed to parse ${path}: ${e.message}. Starting with empty cache.`);
    return { version: 1, entries: [] };
  }
}

export function saveCache(cache, path = CACHE_PATH) {
  cache.updated_at = new Date().toISOString().slice(0, 10);
  writeFileSync(path, JSON.stringify(cache, null, 2) + '\n');
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'should',
  'can', 'could', 'may', 'might', 'must', 'shall', 'to', 'of', 'in', 'on',
  'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'from', 'up', 'down', 'out',
  'off', 'over', 'under', 'again', 'further', 'then', 'once', 'this', 'that',
  'these', 'those', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'they',
  'them', 'their', 'or', 'and', 'but', 'if', 'because', 'as', 'while', 'so',
  'what', 'which', 'who', 'whom', 'how', 'where', 'when', 'why',
  'currently', 'today', 'now', 'please', 'kindly',
  'input', 'tell', 'describe', 'list', 'provide', 'enter', 'fill',
  'many', 'much', 'long', 'short', 'old',
  'role', 'roles', 'position', 'positions', 'company',
  'relevant', 'specifically', 'generally', 'typically',
]);

export function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

// Jaccard similarity over token sets — symmetric, used for cache fuzzy match.
export function similarity(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Containment over the SHORTER set — asymmetric. Used when matching a field
// label (usually short / curt) against a Q&A question (usually verbose). High
// score = "the form label's distinctive words are mostly inside the question".
export function containment(short, long) {
  const S = new Set(tokenize(short));
  const L = new Set(tokenize(long));
  if (S.size === 0) return 0;
  let inter = 0;
  for (const t of S) if (L.has(t)) inter++;
  return inter / S.size;
}

// Find the best match for a label among entries; returns null if below threshold.
export function findCacheMatch(cache, label, threshold = 0.55) {
  let best = null;
  let bestScore = 0;
  for (const e of cache.entries) {
    const s = similarity(e.question_pattern, label);
    if (s > bestScore) { bestScore = s; best = e; }
  }
  if (best && bestScore >= threshold) {
    return { entry: best, similarity: bestScore };
  }
  return null;
}

export function upsertCacheEntry(cache, { question_pattern, answer, answer_combobox, source }) {
  const existing = cache.entries.findIndex(
    e => e.question_pattern.toLowerCase() === question_pattern.toLowerCase()
  );
  const record = {
    question_pattern,
    answer,
    ...(answer_combobox ? { answer_combobox } : {}),
    source: source || 'session',
    learned_at: new Date().toISOString().slice(0, 10),
  };
  if (existing >= 0) {
    cache.entries[existing] = { ...cache.entries[existing], ...record };
  } else {
    cache.entries.push(record);
  }
  return cache;
}
