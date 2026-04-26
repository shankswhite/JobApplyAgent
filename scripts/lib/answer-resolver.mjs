//
// scripts/lib/answer-resolver.mjs
//
// Given a form field record (from extract-form-fields) and a context object
// (boilerplate / Section G / cache / report), figure out the best answer.
//
// Resolution priority:
//   1. Identity / contact (label regex match against boilerplate.identity)
//   2. EEO patterns (gender, race, hispanic, veteran, disability)
//   3. Work auth ("authorized to work" → Yes, "sponsorship" → Yes)
//   4. Standard form fields (how-heard, salary, referral)
//   5. Section G semantic fields (cover_letter — text only, why_company,
//      why_role, spotlight, additional_info)
//   6. Section G custom Q&A (per-report list of question/answer pairs)
//   7. Local answer cache (fuzzy match on question text)
//   8. Unanswered → caller surfaces it for manual fill
//
// Returns { answer, source, confidence, type_hint } or null.
//

import { findCacheMatch, similarity, containment } from './answer-cache.mjs';

// IDENTITY_PATTERNS — order matters. Patterns are tried top-to-bottom and
// the first match wins. Legal-explicit patterns (e.g. "Legal first name",
// "First name as on passport") are tried BEFORE preferred-default patterns
// so they override the public-facing first name with the legal first name.
//
// Default behaviour for the bare "First Name" question:
//   • If the form ALSO has a Preferred / Common / Nick name field, the
//     bare First Name slot is asking for legal → identity.first_name.
//   • If the form has only one name field, it gets the public name →
//     identity.preferred_name (falls back to first_name when blank).
// This is decided in resolveAnswer() via ctx.hasPreferredNameField (set by
// fill-form.mjs's pre-pass over the form's full field list).
const IDENTITY_PATTERNS = [
  // Legal-explicit (must come first — overrides the preferred default).
  { re: /\blegal\s+(first|given)\s*name|first\s*name.*legal|given\s*name.*legal|name.*(?:on\s+passport|on\s+government|government[\s-]?issued|on\s+id|on\s+identification|as\s+(?:it\s+)?appears.*(?:passport|id|government))/i, key: 'first_name_legal' },
  { re: /\blegal\s+(last|family|sur)\s*name|last\s*name.*legal|family\s*name.*legal|surname.*legal/i, key: 'last_name' },
  { re: /^legal\s+name$|legal\s+full\s*name|full\s+legal\s*name/i, key: 'full_name_legal' },

  // Preferred / common / chosen / nick name — match BEFORE generic first_name
  // so labels like "Preferred First Name" or "What should we call you?" go
  // here, not into first_name.
  { re: /preferred|^common.?name|^nick.?name|^chosen.?name|^display.?name|what.*should.*we.*call|what.*do.*you.*go.*by/i, key: 'preferred_name' },

  // Generic first/last/full — first_name resolution is dynamic (see resolver).
  { re: /^first.?name|^given.?name/i, key: 'first_name' },
  { re: /^last.?name|^family.?name|^surname/i, key: 'last_name' },
  { re: /^(full.?)?name$/i, key: 'full_name' },

  { re: /^email/i, key: 'email' },
  { re: /^phone|^mobile|^cell/i, key: 'phone' },
  { re: /\blinkedin\b/i, key: 'linkedin' },
  { re: /\bgithub\b/i, key: 'github' },
  { re: /(personal\s)?website|\bportfolio\b|personal\s?site/i, key: 'website' },
  { re: /\bpronoun/i, key: 'pronouns' },
  { re: /^country$|country.*residence/i, key: 'country' },
  { re: /^location\b|^city\b|where.*located|current.*location|location.*city/i, key: 'location' },
  { re: /\baddress\b|where.*based|home\s+address|residential\s+address/i, key: 'location' },
];

const EEO_PATTERNS = [
  { re: /^gender|identify.*gender/i, key: 'gender' },
  { re: /hispanic|latino/i, key: 'hispanic' },
  { re: /^race$|ethnicity|race.?ethnicity|identify.*race|please.*race|select.*race/i, key: 'race' },
  { re: /veteran/i, key: 'veteran' },
  { re: /disability|disabled/i, key: 'disability' },
];

const WORK_AUTH_PATTERNS = [
  { re: /(legally\s+)?authoriz(ed|ation).*work/i, value: 'Yes' },
  { re: /sponsorship.*employment|require.*sponsorship|visa.*sponsorship|require.*visa/i, value: 'Yes' },
];

const STANDARD_PATTERNS = [
  { re: /how.*hear.*about|how.*find.*us|referral.*source|how.*hear/i, key: 'how_heard' },
  { re: /salary|compensation.*expect|compensation.*range|expected.*compensation|desired.*comp/i, key: 'salary_single_number' },
  { re: /\b(have\s+you\s+been\s+)?referred\b|\breferral\b|do.*you.*know.*anyone/i, value: 'No' },
  { re: /\bstart\s+date\b|when.*can.*you.*start|earliest.*start|earliest.*you.*want.*to.*start|notice.*period/i, key: 'start_date' },
  { re: /\brelocat(e|ion)\b|willing.*to.*relocate|open.*to.*relocat/i, value: 'Yes' },
];

// Education fields — resolved against boilerplate.educations[ctx.eduIndex].
// The patterns are anchored or word-boundaried so they don't accidentally
// match unrelated questions (e.g. "What's your degree of confidence" would
// otherwise match /degree/).
const EDUCATION_PATTERNS = [
  { re: /^school$|university|college|institution|^school name/i, key: 'school' },
  { re: /^degree$|degree.*type/i, key: 'degree' },
  { re: /^discipline$|field\s+of\s+study|^major$|concentration/i, key: 'discipline' },
  { re: /^start\s+date\s+month$|degree.*start.*month|education.*start.*month/i, key: 'start_month' },
  { re: /^start\s+date\s+year$|degree.*start.*year|education.*start.*year/i, key: 'start_year' },
  { re: /^end\s+date\s+month$|graduation.*month|completion.*month|degree.*end.*month/i, key: 'end_month' },
  { re: /^end\s+date\s+year$|graduation.*year|completion.*year|degree.*end.*year/i, key: 'end_year' },
  { re: /^gpa$|grade\s+point\s+average/i, key: 'gpa' },
];

const SECTION_G_PATTERNS = [
  { re: /^cover\s?letter/i, key: 'cover_letter', textOnly: true },
  // "Why <Company>?" — anchored prefix catches generic "why <CompanyName>"
  // labels before falling through to the more specific "Why this role?"
  // patterns.
  { re: /^why\s+\w+\??\s*$|why.*interested.*\b(company|role)|why.*do.*you.*want.*(work|join)|why.*are\s+you.*(interested|excited).*(apply|us|company)/i, key: 'why_company' },
  { re: /why.*this.?role|why.*specifically.*role|why.*excited.*role|reasons.*excited.*apply/i, key: 'why_role' },
  { re: /tell.*about.*project|\bspotlight\b|describe.*project|\bS\.T\.A\.R\b|proudest.*project/i, key: 'spotlight', textOnly: true },
  { re: /anything.*else|additional.*info|additional.*information|is.*there.*anything/i, key: 'additional_info' },
];

const COMBOBOX_TYPES = new Set(['select', 'combobox', 'radio_group']);

// EEO answer formatting: combobox values must match the visible option text.
// Boilerplate stores plain "Male" / "No" / "I am not a protected veteran" /
// "I do not have a disability" — these match Greenhouse defaults.
function eeoAnswerForCombobox(boilerplate, key) {
  const e = boilerplate.eeo || {};
  return e[key] || '';
}

function shortenForCombobox(answer) {
  if (!answer) return '';
  const s = String(answer).trim();
  // Common Yes/No prefixes — take just the first word/sentence.
  const m = s.match(/^(Yes|No|Maybe|N\/A|I (?:am|do|have))\b[\s.,]/);
  if (m) return m[1] === 'I' ? s.split(/[.\n]/)[0] : m[1];
  // Otherwise return up to first sentence (max 60 chars).
  const firstSentence = s.split(/[.\n]/)[0].trim();
  return firstSentence.length <= 60 ? firstSentence : firstSentence.slice(0, 60);
}

function matchPatterns(label, patterns) {
  for (const p of patterns) {
    if (p.re.test(label)) return p;
  }
  return null;
}

export function resolveAnswer(field, ctx) {
  const { boilerplate, sectionG, cache } = ctx;
  const label = field.label || '';
  const isCombobox = COMBOBOX_TYPES.has(field.type);

  // 1. Identity
  const id = matchPatterns(label, IDENTITY_PATTERNS);
  if (id) {
    const legalFirst = boilerplate.identity.first_name;       // legal first name
    const preferred = boilerplate.identity.preferred_name;    // preferred / common
    const lastName = boilerplate.identity.last_name;          // surname
    const publicFirst = preferred || legalFirst;              // public default
    let val;
    switch (id.key) {
      case 'first_name_legal':
        val = legalFirst;
        break;
      case 'full_name_legal':
        val = `${legalFirst} ${lastName}`.trim();
        break;
      case 'preferred_name':
        val = preferred;
        break;
      case 'first_name':
        // Public name by default. If the form has a SEPARATE preferred-name
        // slot, this generic "First Name" question is asking for legal.
        val = ctx.hasPreferredNameField ? legalFirst : publicFirst;
        break;
      case 'full_name':
        val = ctx.hasPreferredNameField
          ? `${legalFirst} ${lastName}`.trim()
          : `${publicFirst} ${lastName}`.trim();
        break;
      default:
        val = boilerplate.identity[id.key];
    }
    if (val) return { answer: val, source: 'boilerplate.identity', confidence: 0.95, type_hint: 'identity' };
  }

  // 2. EEO
  const eeo = matchPatterns(label, EEO_PATTERNS);
  if (eeo) {
    const val = eeoAnswerForCombobox(boilerplate, eeo.key);
    if (val) return { answer: val, source: 'boilerplate.eeo', confidence: 0.9, type_hint: 'eeo' };
  }

  // 3. Work auth (yes/no — must come before "salary" since "authorization" is specific)
  for (const wa of WORK_AUTH_PATTERNS) {
    if (wa.re.test(label)) {
      return { answer: wa.value, source: 'boilerplate.work_auth', confidence: 0.85, type_hint: 'yes_no' };
    }
  }

  // 4. Standard form fields
  const std = matchPatterns(label, STANDARD_PATTERNS);
  if (std) {
    if (std.value) {
      return { answer: std.value, source: 'boilerplate.standard', confidence: 0.7, type_hint: 'standard' };
    }
    if (std.key === 'how_heard') {
      const val = sectionG.overrides.how_heard || boilerplate.fallback_how_heard;
      if (val) return { answer: val, source: 'boilerplate.how_heard', confidence: 0.8 };
    }
    if (std.key === 'salary_single_number') {
      const val = sectionG.salary_single_number || boilerplate.fallback_salary_single_number;
      if (val) return { answer: val, source: 'section_g.salary', confidence: 0.85, type_hint: 'salary' };
    }
    if (std.key === 'start_date') {
      // Pull from cache or default to "Two weeks after offer"
      const cached = findCacheMatch(cache, label);
      if (cached) return { answer: cached.entry.answer, source: 'cache', confidence: cached.similarity };
      // Fall through to manual
    }
  }

  // 4.5 Education (multi-entry support via ctx.eduIndex; default 0).
  // Boilerplate.educations[i] is the source of truth — cache values for
  // School/Degree/months/years are no longer maintained because (a) the
  // user has dual-MS so a single cached answer is wrong for entry 2 and
  // (b) Greenhouse Degree options use "Master's Degree" not "Master of
  // Science" — we encode the right strings once in the boilerplate table.
  const edu = matchPatterns(label, EDUCATION_PATTERNS);
  if (edu) {
    const idx = Number.isInteger(ctx.eduIndex) ? ctx.eduIndex : 0;
    const entry = (boilerplate.educations || [])[idx];
    if (entry && entry[edu.key]) {
      return {
        answer: entry[edu.key],
        source: `boilerplate.educations[${idx}].${edu.key}`,
        confidence: 0.95,
        type_hint: 'education',
      };
    }
  }

  // 5. Section G semantic fields
  const sg = matchPatterns(label, SECTION_G_PATTERNS);
  if (sg) {
    // textOnly means "skip if this is a file/upload field" (cover letter file goes through upload path, not text fill)
    if (sg.textOnly && (field.type === 'file')) return null;
    const val = sectionG[sg.key];
    if (val) return { answer: val, source: `section_g.${sg.key}`, confidence: 0.85 };
  }

  // 6. Section G custom Q&A — match using containment on the field label
  // (asymmetric: how many distinctive tokens of the label appear in the
  // question). Threshold 0.6 = ≥60% of the label's content words present.
  if (sectionG.custom_qa && sectionG.custom_qa.length > 0) {
    let bestQa = null;
    let bestScore = 0;
    for (const qa of sectionG.custom_qa) {
      const s = containment(label, qa.question);
      if (s > bestScore) { bestScore = s; bestQa = qa; }
    }
    if (bestQa && bestScore >= 0.6) {
      let answer = bestQa.answer;
      if (isCombobox) answer = shortenForCombobox(answer);
      return { answer, source: 'section_g.custom_qa', confidence: bestScore, type_hint: 'custom_qa' };
    }
  }

  // 7. Local cache (lower threshold than default — labels often have noise
  // words like "Please" / "(Required)" / "(Private)" the question doesn't.)
  const hit = findCacheMatch(cache, label, 0.4);
  if (hit) {
    let answer = isCombobox && hit.entry.answer_combobox ? hit.entry.answer_combobox : hit.entry.answer;
    if (isCombobox && !hit.entry.answer_combobox) answer = shortenForCombobox(answer);
    if (!answer) return null; // empty cache answer → treat as miss, don't overwrite
    return { answer, source: 'cache', confidence: hit.similarity, type_hint: 'cache' };
  }

  // 8. Miss
  return null;
}

// Build the "context" object passed to resolveAnswer
export function buildContext({ boilerplate, report, cache }) {
  return {
    boilerplate,
    sectionG: {
      cover_letter: report.section_g.cover_letter,
      why_company: report.section_g.why_company,
      why_role: report.section_g.why_role,
      spotlight: report.section_g.spotlight,
      additional_info: report.section_g.additional_info || boilerplate.additional_info,
      salary_single_number: report.section_g.salary_single_number || boilerplate.fallback_salary_single_number,
      salary_phrasing: report.section_g.salary_phrasing,
      custom_qa: report.section_g.custom_qa || [],
      overrides: report.section_g.overrides || {},
    },
    cache,
  };
}
