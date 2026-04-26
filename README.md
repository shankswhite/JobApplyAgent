# JobApplyAgent

> **The most powerful job apply bot.**
> Auto-evaluate openings, generate tailored CVs, fill the ATS form across
> Greenhouse / Ashby / Lever / Workday, and let your computer-use agent
> click Submit. You stay in the loop — but only as the final reviewer.

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT">
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white" alt="Playwright">
  <img src="https://img.shields.io/badge/Anthropic-000?style=flat&logo=anthropic&logoColor=white" alt="Anthropic">
  <img src="https://img.shields.io/badge/Hermes-7C3AED?style=flat" alt="Hermes Agent">
  <img src="https://img.shields.io/badge/OpenClaw-EA580C?style=flat" alt="OpenClaw">
</p>

---

## The vision: Recruiter email → Applied. In one loop.

```
  ┌─────────────────────────────────────────────────────────────┐
  │  📧  Hermes  (IMAP polling, every 15s)                      │
  │      Reads inbox → extracts JD URL + recruiter context      │
  └────────────────────────┬────────────────────────────────────┘
                           │  applications.md row
                           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  🧠  JobApplyAgent::eval                                    │
  │      A-F scoring · 10 weighted dimensions                   │
  │      Skip if score < 4.0/5 — your time is finite            │
  └────────────────────────┬────────────────────────────────────┘
                           │  per-role report.md
                           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  📄  JobApplyAgent::render                                  │
  │      Tailored ATS-optimized PDF (cv-{slug}.pdf)             │
  │      Per-role cover letter PDF                              │
  └────────────────────────┬────────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  🤖  JobApplyAgent::fill   ← the differentiating layer      │
  │      Dynamic DOM scan · layered answer resolver             │
  │      Local learning cache · multi-pass conditional fields   │
  │      Cover letter upload · multi-entry education            │
  │      Async typeahead combobox polling                       │
  └────────────────────────┬────────────────────────────────────┘
                           │  ready browser tab
                           ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  🖱  OpenClaw  (or you)                                      │
  │      Final review → Submit click                            │
  └─────────────────────────────────────────────────────────────┘
```

You stay in the loop, but only as the **final reviewer** — the boring
parts (scoring, CV tailoring, form-filling) run themselves.

---

## Why this exists

I spent weeks applying to ML/AI engineer roles the manual way. Three
things were broken:

1. **Eval was a coin flip.** I'd waste 20 minutes per JD figuring out
   "is this really for me?" before realizing I should've skipped it.
2. **CV tailoring didn't scale.** Re-keywording one CV per role for
   100+ roles is a part-time job.
3. **Auto-fill was brittle.** Off-the-shelf "apply" extensions handle
   ~40% of fields and silently skip the rest. They don't understand
   conditional fields, multi-entry education, async typeahead, or the
   difference between "First Name" and "Legal First Name".

JobApplyAgent fixes #3 (the auto-fill engine, the part this fork
adds), and pairs cleanly with `santifer/career-ops` for #1 and #2.

> **This is NOT a spray-and-pray tool.** The eval layer's job is to
> reject 70% of roles before you spend a single minute on them.
> The fill layer's job is to make the 30% that pass take 2 minutes
> instead of 20.

---

## What's in this fork

JobApplyAgent is a fork of [`santifer/career-ops`][upstream] with one
major addition: the **dynamic auto-fill engine** in `scripts/lib/`.

| Layer | Source | Status |
|-------|--------|--------|
| Job scanning (45+ companies, custom queries) | upstream | ✅ |
| A-F evaluation (10-dimension weighted scoring) | upstream | ✅ |
| ATS-optimized CV PDF generation | upstream | ✅ |
| Tracker / pipeline / dashboard / TUI | upstream | ✅ |
| **Dynamic ATS form auto-fill** | this fork | ✅ |
| **Layered answer resolver** | this fork | ✅ |
| **Local learning cache** | this fork | ✅ |
| **Cover letter PDF generation** | this fork | ✅ |
| **Multi-entry education + conditional fields** | this fork | ✅ |
| **Email trigger (Hermes)** | this fork | 🚧 roadmap |
| **Computer-use Submit (OpenClaw)** | this fork | 🚧 roadmap |

[upstream]: https://github.com/santifer/career-ops

---

## The auto-fill engine (the differentiating layer)

Most "auto-apply" tools fail because ATS forms aren't static. They have
async typeahead comboboxes, fields that materialize after you answer
others, multi-row sections with `+ Add another` buttons, and labels
that don't match the underlying `name` attribute.

JobApplyAgent's fill engine handles all of this:

### Dynamic DOM scanner — `scripts/lib/extract-form-fields.mjs`

- Injects stable `data-cv-field-id` attributes so re-renders don't
  break selectors.
- Resolves labels from preceding siblings, parent containers,
  `aria-labelledby`, and explicit `<label for>` — in that order.
- Dedupes Greenhouse React-Select hidden-input + visible-combobox
  pairs (saves ~30% of false-positive fields).
- Disambiguates "Resume / CV" vs "Cover Letter" file uploads by
  scanning for nearby labels and dropzone text.
- Falls back to `(unlabeled combobox)` placeholder labels so nothing
  is silently skipped.

### Layered answer resolver — `scripts/lib/answer-resolver.mjs`

Resolution priority (first match wins):

1. **Identity / contact** (boilerplate.identity, with legal-vs-preferred
   name disambiguation when the form has a separate "Preferred Name"
   field).
2. **EEO / demographic** (gender, race, veteran, disability, hispanic).
3. **Work authorization** (visa, sponsorship, located in country).
4. **Standard fields** (salary, start date, "how did you hear", etc).
5. **Education** (multi-entry support via `ctx.eduIndex`).
6. **Section G semantic fields** (cover letter text, why-company,
   why-role, spotlight, additional-info — sourced from each report).
7. **Section G custom Q&A** (per-role overrides).
8. **Local cache** (fuzzy containment match against past answers).
9. **Manual** — surface the field in the unanswered manifest.

The `cache` layer means the system gets smarter every batch — you fill
each new question once, and it auto-fills on every future role with a
similar question.

### Multi-pass form filler — `scripts/lib/fill-form.mjs`

Three passes per form:

1. **Initial fill** of all detected fields.
2. **Conditional reveal** — re-scan after step 1 because some fields
   only render after you answer others (e.g. `Race` only appears after
   you answer `Hispanic/Latino?` `No`).
3. **Multi-entry education** — click `+ Add another` for each row in
   `boilerplate.educations[]`, re-scan, fill the new entry against
   `educations[i]`. Guarded by `firstPassFilledEducation` so forms
   without an education section don't get phantom Add-another loops.

For async typeahead comboboxes (Greenhouse School/Degree fields), the
filler types a discriminating prefix and polls for ~2.5s with
`exact → startsWith → contains` option matching before pressing Enter.

### Self-improving cache — `data/form-answers-cache.json`

Every unanswered field becomes a row in `data/unanswered-YYYY-MM-DD.md`
after a batch. You fill in answers in markdown, run
`npm run apply:learn`, and they're folded into the cache. Future
batches auto-fill them. Containment matching means the same answer
covers slight wording variations across companies.

### Cover letter PDF generator — `scripts/render-cover-letter.mjs`

Reads each report's `## Section G` `cover_letter` block, renders to PDF
via Playwright's print engine using the same fonts as the CV PDF
(Space Grotesk + DM Sans). The fill engine then locates the form's
"Cover Letter" upload field and uploads the matching PDF, or pastes
the text into a textarea fallback.

---

## Quickstart

### 1. Clone and install

```bash
git clone https://github.com/shankswhite/JobApplyAgent.git
cd JobApplyAgent
npm install
npx playwright install chromium
```

### 2. Copy the templates

```bash
# personal data (gitignored after copy):
cp cv.md.template cv.md
cp data/applications.md.template data/applications.md
cp data/pipeline.md.template data/pipeline.md
cp data/section-g-boilerplate.md.template data/section-g-boilerplate.md
cp data/form-answers-cache.json.template data/form-answers-cache.json
cp config/profile.example.yml config/profile.yml
cp examples/portals.example.yml portals.yml          # if shipped, else copy from upstream
```

Then edit each one with your real data. **Nothing is auto-pushed back**
— `.gitignore` covers all five files.

### 3. Evaluate a role

Use any AI coding CLI (Claude Code, Cursor, OpenCode, Gemini CLI). Open
the project in your CLI and run the eval mode against a JD URL — see
`modes/pipeline.md` for the full prompt. The eval writes a per-role
`reports/NNN-{slug}-{date}.md` and updates `data/applications.md` with
the row marked `Evaluated`.

### 4. Apply (batch mode)

```bash
# render PDFs first (one CV per role)
node generate-pdf.mjs

# render cover letters
node scripts/render-cover-letter.mjs --all

# auto-fill all Evaluated roles in one Chromium window
node scripts/apply-batch.mjs --all --yes

# or just tier-1 (score >= 4.0/5)
node scripts/apply-batch.mjs --tier1 --yes

# or specific IDs
node scripts/apply-batch.mjs 5 16 44 --yes
```

The browser stays open. Cmd-1 / Cmd-2 / ... through the tabs, review,
click Submit yourself.

### 5. Learn from this batch

After the batch, any field the resolver couldn't fill lands in
`data/unanswered-YYYY-MM-DD.md`. Edit it, then:

```bash
npm run apply:learn -- data/unanswered-2026-04-26.md
```

Future batches auto-fill those questions.

---

## Architecture

```
                                    ┌──────────────────────────┐
   data/applications.md ────────┬──▶│ scripts/apply-batch.mjs  │
   reports/NNN-*.md ────────────┤   │  (orchestrator)          │
   output/cv-*-{slug}.pdf ──────┤   └────────────┬─────────────┘
   output/cover-letter-*.pdf ───┘                │ per-role
                                                  ▼
                                ┌──────────────────────────────┐
                                │  scripts/lib/fill-form.mjs   │
                                │  navigateAndFill()           │
                                └────────────┬─────────────────┘
                                             │
                              ┌──────────────┼──────────────┐
                              ▼              ▼              ▼
              ┌──────────────────────┐  ┌──────────┐  ┌──────────────┐
              │ extract-form-fields  │  │ resolver │  │ answer-cache │
              │  (DOM scan + dedupe) │  │ (8-layer)│  │  (fuzzy)     │
              └──────────────────────┘  └────┬─────┘  └──────────────┘
                                             │ pulls from:
                                             ├─ boilerplate (section-g)
                                             ├─ report.section_g
                                             └─ form-answers-cache.json
```

Standalone CLI tools that complement the engine:

- `scripts/probe-form.mjs <url>` — diagnostic. Inspects any ATS form,
  prints field metadata, combobox options (with/without typing), and
  `+ Add another` button selectors. Use this when adding support for
  a new ATS or debugging a stuck field.
- `scripts/scan-form.mjs <url>` — single-form quick scan, no fill.
- `scripts/dump-form-labels.mjs <url>` — minimal label dump for
  resolver pattern-tuning.
- `scripts/learn-answers.mjs <manifest.md>` — folds a filled-in
  unanswered manifest back into the cache.

---

## Roadmap: full email-to-applied loop

The current state requires **you** to (a) point the eval at a JD URL
and (b) hit Submit at the end. Two integrations close that loop:

### 🚧 Hermes integration (email trigger)

[Hermes Agent](https://hermes-agent.nousresearch.com/) is Nous
Research's MIT-licensed self-improving agent with native IMAP / SMTP
support. The integration plan:

1. Hermes polls Gmail / Outlook every 15s with a JD-URL extraction
   prompt.
2. When a recruiter email contains a careers / Greenhouse / Ashby /
   Lever / Workday URL, Hermes writes a row to `data/pipeline.md`
   with `URL`, `Source: hermes:{recruiter-email}`, `Stage: New`.
3. A pre-existing `claude -p eval` worker watches `pipeline.md` for
   new rows, runs the eval, promotes to `data/applications.md` if
   score ≥ 4.0/5.
4. (optional) Hermes also drafts a polite "thanks, applying" reply
   to the recruiter once the form has been auto-filled.

This will live in `scripts/integrations/hermes/` once shipped.

### 🚧 OpenClaw integration (computer-use Submit)

[OpenClaw](https://github.com/openclaw/openclaw) is a personal
AI-agent daemon with a `computer-use` plugin in active development
(PR #40640). The integration plan:

1. After `apply-batch.mjs` opens its 10 tabs ready-to-submit,
   `JobApplyAgent::handoff` writes a `data/handoff-{batch-id}.json`
   manifest with: tab URL, screenshot, list of filled fields, list
   of unanswered fields.
2. OpenClaw reads the manifest, takes a screenshot, runs a
   safety-checked verification ("does this look right? are all
   required fields filled? is the salary in the expected range?"),
   and only then clicks Submit.
3. On verification failure, OpenClaw posts the screenshot to your
   Discord / Telegram / Slack via its built-in messaging adapters
   for human review.

This will live in `scripts/integrations/openclaw/` once shipped.

> **Both integrations are opt-in.** Without them, JobApplyAgent runs
> exactly as it does today: you hit Submit, you stay in control.

---

## Real-world numbers

From the latest batch run (10 ML/AI engineer roles, mostly
Greenhouse + one Ashby):

```
✅ Batch complete — 10 tabs ready for review (4.4m)
Tab │ ID  │ Scan │ Fill │ Up │ Unans │ Status
  1 │ 002 │   13 │   11 │  1 │     0 │ ✅ ready to submit
  2 │ 005 │   30 │   28 │  2 │     0 │ ✅ ready to submit
  3 │ 008 │   25 │   23 │  1 │     1 │ ⚠ 1 optional field
  4 │ 011 │   17 │   16 │  1 │     0 │ ✅ ready to submit
  5 │ 015 │   21 │   18 │  2 │     0 │ ✅ ready to submit
  6 │ 016 │   19 │   17 │  2 │     0 │ ✅ ready to submit
  7 │ 038 │   21 │   18 │  2 │     0 │ ✅ ready to submit
  8 │ 039 │   21 │   18 │  2 │     0 │ ✅ ready to submit
  9 │ 044 │   19 │   17 │  2 │     0 │ ✅ ready to submit
 10 │ 045 │   19 │   17 │  2 │     0 │ ✅ ready to submit
📊 9/10 tabs ready to submit blind
```

- **Scan**: total form fields detected (incl. file uploads).
- **Fill**: text / select / combobox fields filled.
- **Up**: uploads (resume + cover letter).
- **Unans**: fields the resolver flagged for manual review.

The single ⚠ row was `(Optional) Personal Preferences` — intentionally
left blank by the cache.

---

## Credits

This project is a fork of and stands entirely on top of
[`santifer/career-ops`][upstream] by **Santiago Fernández de
Valderrama**. The eval, scoring, scanning, CV-rendering, dashboard,
and tracker layers all come from there. Go star and read it — it's a
thoughtful piece of work.

The auto-fill engine, layered resolver, learning cache, cover letter
generator, and the planned Hermes / OpenClaw integrations are the
contributions added in this fork.

[upstream]: https://github.com/santifer/career-ops

---

## License

MIT — see [LICENSE](./LICENSE).
