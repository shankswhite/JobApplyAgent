# Contributors

JobApplyAgent stands on the shoulders of [`santifer/career-ops`][upstream]
and its contributor community. Everyone listed in
[upstream/CONTRIBUTORS.md][upstream-contributors] shaped the eval / scan /
CV-render / dashboard layers this fork builds on top of.

## This fork

- **[@shankswhite](https://github.com/shankswhite)** (Levon Zhao) —
  Author of the auto-fill engine (`scripts/lib/`, `scripts/apply-batch.mjs`,
  `scripts/apply-form.mjs`, `scripts/render-cover-letter.mjs`,
  `scripts/probe-form.mjs`, `scripts/learn-answers.mjs`, the
  `data/section-g-boilerplate.md` schema, and `modes/apply.md`).

## How to contribute

PRs welcome. The auto-fill engine is the only part of this fork
maintained here — for upstream features (eval / scan / CV render /
dashboard / TUI), please contribute to [`santifer/career-ops`][upstream]
directly.

For ATS support requests (Workday, Taleo, iCIMS, etc.), please open an
issue with:
1. A public job URL on that ATS.
2. The output of `node scripts/probe-form.mjs <url>`.
3. Which fields the resolver is missing.

[upstream]: https://github.com/santifer/career-ops
[upstream-contributors]: https://github.com/santifer/career-ops/blob/main/CONTRIBUTORS.md
