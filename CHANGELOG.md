# Changelog

All notable changes to **JobApplyAgent** will be documented in this file.
For the upstream `santifer/career-ops` history before this fork, see
<https://github.com/santifer/career-ops/blob/main/CHANGELOG.md>.

## [0.1.0] - 2026-04-26

Initial public release of **JobApplyAgent** — fork of `santifer/career-ops`
plus a new auto-fill engine.

### Added

- **`scripts/lib/extract-form-fields.mjs`** — Dynamic DOM scanner that injects
  `data-cv-field-id` attributes for stable re-location across re-renders.
  Handles Greenhouse React-Select dedupe, Ashby div-based forms, label
  resolution from preceding siblings / parent containers, and unlabeled
  combobox placeholder injection.
- **`scripts/lib/answer-resolver.mjs`** — Layered answer resolution
  (boilerplate → EEO → standard → Section G → custom Q&A → cache → manual).
  Includes legal-vs-preferred name disambiguation, multi-entry education
  pattern matching, broadened EEO patterns, and conditional-reveal handling
  for race fields gated on Hispanic/Latino.
- **`scripts/lib/answer-cache.mjs`** — Persistent local cache with fuzzy
  containment matching and combobox-aware answer shortening.
- **`scripts/lib/fill-form.mjs`** — Multi-pass form filler:
  1. Initial fill of all detected fields
  2. Conditional-reveal pass for fields gated on prior answers
  3. Multi-entry education pass via `+ Add another` button click + re-scan
  4. Async typeahead combobox polling (~2.5s) with exact / startsWith /
     contains option matching
- **`scripts/lib/parse-boilerplate.mjs`** — Multi-row markdown table parser
  for `data/section-g-boilerplate.md` Section 11 (multi-education entries).
- **`scripts/apply-batch.mjs`** — Sequential batch filler. One Chromium
  window, N tabs, fills 10+ roles in ~5 minutes. Generates an "unanswered"
  manifest of fields the resolver couldn't fill, ready for `learn-answers.mjs`
  to fold into the cache.
- **`scripts/apply-form.mjs`** — Single-role auto-fill driver.
- **`scripts/render-cover-letter.mjs`** — Generates per-role cover letter
  PDFs from each report's Section G content.
- **`scripts/probe-form.mjs`** — Generalized diagnostic CLI to inspect any
  ATS form for field metadata, combobox options (with/without typing), and
  `+ Add another` button selectors.
- **`scripts/learn-answers.mjs`** — Folds the unanswered manifest into the
  local answer cache after the user fills in answers.
- **`modes/apply.md`** — New mode for the auto-fill subsystem.

### Changed

- Replaced 8-language READMEs with single English `README.md` framed around
  the auto-fill engine + email-trigger roadmap.
- Reset `CHANGELOG.md` to start fresh at v0.1.0 for the fork. Upstream
  history preserved upstream.
- Extended `.gitignore` to cover the new sensitive files
  (`data/section-g-boilerplate.md`, `data/form-answers-cache.json`,
  `data/unanswered-*.md`).
- `package.json` re-pointed to the fork (name, repo, author).
