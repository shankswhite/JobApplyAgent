# Mode: apply — Live Application Assistant

Interactive mode for when the candidate is filling out a job application form in Chrome. Reads what's on screen, loads prior context for the role, and generates personalized answers for each form question.

## Requirements

- **Best with Playwright visible**: In visible mode, the candidate can see the browser and Claude can interact with the page.
- **Without Playwright**: the candidate shares a screenshot or pastes the questions manually.

## Architecture: snapshot-driven auto-fill (since 2026-04-26)

The fill engine no longer uses hardcoded "look for label X, fill Y" pairs. Instead:

1. **`scripts/lib/extract-form-fields.mjs`** runs in `page.evaluate()` to walk the live DOM and emit one record per visible interactive field: `{label, type, name, id, selector, required, currentValue, options, placeholder}`. Every Greenhouse `react-select` widget is deduped (text+combobox twins collapse), every Greenhouse file upload is name-disambiguated (`Resume / CV` vs `Cover Letter`), and any field that lacks a stable selector gets stamped with our own `data-cv-field-id` attribute so we can re-locate it. **The page is the source of truth** for which fields exist; nothing is assumed.

2. **`scripts/lib/answer-resolver.mjs`** maps each detected field to an answer using this priority order:
   1. `boilerplate.identity` — first/last name, email, phone, LinkedIn, GitHub, website, location, country, pronouns
   2. `boilerplate.eeo` — gender, hispanic/latino, race, veteran, disability
   3. Work-auth heuristics — "authorized to work" → Yes, "sponsorship" → Yes
   4. Standard form fields — "how heard" / "compensation expectations" / "referred" / "willing to relocate" / "start date"
   5. `Section G` semantic fields from the report — `cover_letter` (text only), `why_company`, `why_role`, `spotlight`, `additional_info`
   6. `Section G` custom Q&A — token-containment match (label tokens ⊂ question tokens, ≥0.6 coverage)
   7. **Local cache** at `data/form-answers-cache.json` — Jaccard fuzzy match against questions answered in past sessions
   8. Miss → field surfaces in the unanswered manifest

3. **`scripts/lib/fill-form.mjs`** picks the right Playwright primitive per field type: `fill()` for text/email/tel/url/number/textarea, `selectOption()` for native selects, click+type+option-pick for comboboxes (Greenhouse react-select, Ashby, etc.), label-text click for radios, `setInputFiles()` for file uploads. Combobox answers from long Section G text get auto-shortened (e.g. "Yes. I'm based in San Jose…" → "Yes" for a Yes/No combobox).

4. **The candidate can keep growing the cache.** After every batch, an unanswered manifest is written to `data/unanswered-YYYY-MM-DD.md`. The candidate writes the answer under each `> ` blockquote, then runs `scripts/learn-answers.mjs <manifest>` to commit each Q→A into `data/form-answers-cache.json`. Next batch, those questions auto-fill.

## Quick auto-fill — `scripts/apply-form.mjs` (single role)

```bash
node scripts/apply-form.mjs <id-or-slug>     # open browser, snapshot-fill
node scripts/apply-form.mjs <id> --dry-run   # print resolved context, no browser
node scripts/apply-form.mjs <id> --headless  # invisible
node scripts/apply-form.mjs <id> --no-upload # skip resume upload
node scripts/apply-form.mjs <id> --login     # first-time auth on Workday/Taleo/iCIMS/LinkedIn
```

At the end, prints `scanned N, filled M, uploaded U, failed F, unanswered K` plus a list of unanswered fields (label + type + options) so the candidate types those by hand before clicking Submit. **Never clicks Submit** itself.

## Diagnostic: `scripts/scan-form.mjs` (no fill, just inspect)

When a form misbehaves or you want to inspect what the extractor sees, run:

```bash
node scripts/scan-form.mjs <id-or-slug>      # print all detected fields + types
node scripts/scan-form.mjs <id> --headless   # invisible
node scripts/scan-form.mjs <id> --json       # JSON, pipe-friendly
node scripts/scan-form.mjs https://...       # arbitrary URL
```

## Batch auto-fill — `scripts/apply-batch.mjs` (sequential, all in one window)

For "fill everything I have, leave the tabs open, I'll submit each myself" mode. **One** Chromium window, **N** tabs (one per role), filled sequentially. Browser stays open until the candidate closes it.

```bash
node scripts/apply-batch.mjs --all           # all `Evaluated` rows in applications.md
node scripts/apply-batch.mjs --tier1         # `Evaluated` rows with score ≥ 4.0
node scripts/apply-batch.mjs 16 5 44 15      # explicit IDs, in order
node scripts/apply-batch.mjs --all --dry-run # preview the queue (no browser)
node scripts/apply-batch.mjs --all --yes     # skip the "press Enter to start" prompt
```

Behavior:
- Reads `data/applications.md`, finds rows whose `Status` column is `Evaluated`, intersects with the requested filter.
- For each role: validates that the report has a `**URL:**`, the tailored PDF exists, and the ATS doesn't require a missing login (otherwise the role is **skipped** with a clear reason printed at the top of the run).
- Launches **one** browser, **one** Playwright context (`modes/_shared.md` red line: never 2+ Playwright in parallel), then `context.newPage()` per role and runs `navigateAndFill` from `scripts/lib/fill-form.mjs`.
- Catches per-role errors so one bad form doesn't kill the batch — that tab still opens, just empty / partial.
- Prints a final summary table: `Tab │ ID │ Scan │ Fill │ Up │ Unans │ Status`.
- Writes `data/unanswered-YYYY-MM-DD.md` listing every still-empty field per tab, with `> ` blockquotes ready for the candidate to type into.

**Learning loop:**

```bash
# 1. Run batch, get tabs filled + a manifest of remaining questions
node scripts/apply-batch.mjs --all

# 2. Open data/unanswered-YYYY-MM-DD.md, type your answer under each `> `
#    (the script pre-fills `scope: cache` so the answer becomes globally reusable;
#    set it to `scope: role` to keep an answer one-off)

# 3. Commit those answers to the local cache
node scripts/learn-answers.mjs data/unanswered-2026-04-26.md
node scripts/learn-answers.mjs data/unanswered-2026-04-26.md --dry-run  # preview
```

Subsequent batches will auto-fill those questions on any role whose form asks something similar (token-Jaccard ≥ 0.55).

Constraint: a single batch can only carry **one** auth platform's session (Playwright limitation: one `storageState` per context). If the queue mixes e.g. Workday + Taleo, the script aborts and asks for two separate runs. Anonymous platforms (Greenhouse, Ashby, Lever public, SmartRecruiters) can mix freely.

## ATS support matrix

| ATS pattern | Requires login? | Auto-fill works? |
|---|---|---|
| `*.greenhouse.io`, `grnh.se` | No | Yes |
| `*.ashbyhq.com` | No | Yes |
| `*.lever.co` (public job page) | No | Yes |
| `*.smartrecruiters.com` | No | Yes |
| `*.myworkdayjobs.com`, `wdN.workday.com` | **Yes** | Yes (after `--login`) |
| `*.taleo.net` | **Yes** | Yes (after `--login`) |
| `*.icims.com` | **Yes** | Yes (after `--login`) |
| `linkedin.com/jobs/...` | **Yes** | Yes (after `--login`) |
| `indeed.com`, `glassdoor.com` | **Yes** | Yes (after `--login`) |

**For platforms that require login**, run once: `node scripts/apply-form.mjs <id> --login`. The browser opens, you log in manually, press Enter in the terminal, and the script saves the session to `.auth/{platform}.json` (gitignored). All future runs for that platform reuse the saved session — no password is ever stored in code or repo. Re-run `--login` when the session expires (~30 days for most ATSes).

**Single source of truth:**
- `data/section-g-boilerplate.md` → identity, EEO, defaults
- `reports/{id}-*.md` Section G → cover letter, why-company, why-role, spotlight, custom Q&A

**Recognized subsections inside `## Section G`** (parser identifies them by header semantics, not by number):
- `### G.X — Cover Letter` → cover letter (any subsection whose header contains "Cover Letter")
- `### G.X — Why are you interested in {Company}?` → why-company
- `### G.X — Why this role specifically?` → why-role
- `### G.X — Spotlight project ...` (or "Tell us about", "STAR") → spotlight
- `### G.X — Anything else / Additional info` → "anything else" field
- `### G.X — Form-specific notes` → advisory notes (NOT auto-filled, only printed in CLI)
- `### G.X — Custom form questions` → Q/A pairs that ARE auto-filled into the form

Subsections with non-standard headers (e.g. `Honesty paragraph`, `Go question`, `TypeScript ramp question`) are surfaced in the CLI as interview-prep context but are NOT auto-filled, since their headers don't map to a real form label.

**Format for "Custom form questions" (G.7 convention):**

```markdown
### G.7 — Custom form questions (auto-fill source for `apply-form.mjs`)

- **Q:** Are you willing and able to commit to the hybrid policy?
  **A:** Yes. I'm based in {City, State} and ready to commit ...

- **Q:** What AI tools are you currently using today?
  **A:** I use {your AI tool} as my daily driver ...

    Production stack: at {your most recent role} ...
```

**Per-role overrides** (optional, in the Section G header):

```markdown
**Form-field overrides:**
- Website: https://your-portfolio.com
- How heard: LinkedIn
```

**When the candidate asks "investigate the form questions and pre-fill them":**
1. Open the form via Playwright snapshot or run `node scripts/dump-form-labels.mjs <url>` to read the real labels.
2. If there are unanswered questions not yet in Section G → generate the answers and append a `### G.7 — Custom form questions` block to the report.
3. Run `node scripts/apply-form.mjs <id>` to auto-fill.
4. **NEVER submit** — the candidate reviews and submits manually.

## Workflow

```
1. DETECT      → Read the active Chrome tab (screenshot / URL / title)
2. IDENTIFY    → Extract company + role from the page
3. SEARCH      → Match against existing reports in reports/
4. LOAD        → Read the full report + Section G (if it exists)
5. COMPARE     → Does the on-screen role match the evaluated one? If it changed → warn
6. ANALYZE     → Identify ALL visible form questions
7. GENERATE    → For each question, generate a personalized answer
8. PRESENT     → Show formatted answers ready for copy-paste
```

## Step 1 — Detect the offer

**With Playwright:** Take a snapshot of the active page. Read title, URL, and visible content.

**Without Playwright:** Ask the candidate to:
- Share a screenshot of the form (the Read tool can read images)
- Or paste the form questions as text
- Or name the company + role so we can look it up

## Step 2 — Identify and load context

1. Extract company name and role title from the page
2. Search `reports/` by company name (case-insensitive Grep)
3. If a match exists → load the full report
4. If Section G exists → load prior draft answers as the baseline
5. If NO match → warn and offer to run the quick auto-pipeline

## Step 3 — Detect role changes

If the on-screen role differs from the evaluated one:
- **Warn the candidate**: "The role changed from [X] to [Y]. Want me to re-evaluate, or just adapt the answers to the new title?"
- **If adapting**: Adjust answers for the new role without re-evaluating
- **If re-evaluating**: Run the full A–F evaluation, update the report, regenerate Section G
- **Update tracker**: Change the role title in `applications.md` if appropriate

## Step 4 — Analyze form questions

Identify ALL visible questions:
- Free-text fields (cover letter, why this role, etc.)
- Dropdowns (how did you hear, work authorization, etc.)
- Yes/No (relocation, visa, etc.)
- Salary fields (range, expectation)
- Upload fields (resume, cover letter PDF)

Classify each question:
- **Already answered in Section G** → adapt the existing answer
- **New question** → generate an answer from the report + cv.md

## Step 5 — Generate answers

For each question, generate the answer following:

1. **Report context**: Use proof points from block B, STAR stories from block F
2. **Prior Section G**: If a draft answer exists, use it as the base and refine it
3. **"I'm choosing you" tone**: Same framework as the auto-pipeline
4. **Specificity**: Reference something concrete from the JD visible on screen
5. **career-ops proof point**: Include it in "Additional info" if the form has such a field

**Output format:**

```
## Answers for [Company] — [Role]

Based on: Report #NNN | Score: X.X/5 | Archetype: [type]

---

### 1. [Exact form question]
> [Answer ready for copy-paste]

### 2. [Next question]
> [Answer]

...

---

Notes:
- [Any observation about the role, changes, etc.]
- [Customization suggestions the candidate should review]
```

## Step 6 — Post-apply (optional)

If the candidate confirms they submitted the application:
1. Update status in `applications.md` from "Evaluated" to "Applied"
2. Update Section G of the report with the final answers
3. Suggest the next step: `/career-ops contacto` for LinkedIn outreach

## Scroll handling

If the form has more questions than are visible:
- Ask the candidate to scroll and share another screenshot
- Or paste the remaining questions
- Process iteratively until the whole form is covered
