# QA report — issue #4, v1

- **Issue:** #4 — Stop duplicate date columns: align README with real schema, make auto-schema non-silent
- **PR:** #9 · branch `issue-4-stop-duplicate-date-columns` · builder commit `9d3eb37`
- **Date:** 2026-08-03
- **Verdict:** ✅ PASS — all 6 acceptance criteria verified, 41/41 harness checks green

## How this was tested

No test framework exists in this repo (per `docs/super-board/PROJECT.md`), so QA is a
behavioral harness plus repo gates:

1. `node harness.mjs` (this folder) — loads the **real `background.js`** in a Node `vm`
   context with a stubbed `chrome.*` surface and a recording `fetch`, then drives
   `saveToNotion()` end-to-end against three mock Notion databases:
   - a **fresh/legacy README-style DB** (Name/Number/Difficulty/Tags/Status/Expertise/
     Date/Review/URL/… as the old README instructed),
   - an **already-correct DB** (exactly `DATABASE_SCHEMA`),
   - a **wrong-type DB** (`Attempts` present as `rich_text`).
   Every Notion HTTP request is captured, so "no silent column creation" is asserted on
   the actual wire traffic, not on log output.
2. Repo gates: `node --check background.js && node --check popup.js` PASS,
   `bash build.sh` PASS (`leetion.zip` builds).
3. Visual evidence: the real `popup.html` + `styles.css` rendered headless
   (chrome-headless-shell) with the schema-confirm block populated by the same DOM
   operations `popup.js showSchemaConfirmation()` performs, using the exact
   `missingColumns` payload the harness captured for the legacy-DB scenario.
   (The popup is a fixed-width extension popup, so it is captured at its natural
   ~400px width instead of desktop/tablet/mobile viewports.)

Full check-by-check output: `harness-output.txt`.

## Per-AC results

| AC | Result | Evidence |
|---|---|---|
| 1. README table matches `DATABASE_SCHEMA` exactly, no stale names | ✅ | 14/14 names+types match; stale names (Date, Review, Name, Number, …) absent from the table — they appear only in the explicitly-labeled "Upgrading from an older setup?" cleanup note, which the issue's constraints require. |
| 2. No silent second date column on legacy DBs | ✅ | Unconfirmed save against the legacy DB returns `needsSchemaConfirmation` with the 9 columns to create; `"Date (of first attempt)"` lists existing same-type columns `Date, Review`; **zero PATCH / zero page writes** occur before confirmation. After confirm, PATCH contains exactly the 9 confirmed columns. Title maps to the DB's real title column (`Name`) instead of creating `Question`. |
| 3. Schema results/errors surfaced, not swallowed | ✅ | Failed column PATCH → `error: "Could not add columns (…): …"` returned to popup, no page write attempted. Failed schema GET → save proceeds with `schemaWarning: "Could not verify database columns: …"`; popup appends created-column list to the success status and logs warnings. |
| 4. Wrong-type same-name column reported clearly | ✅ | `Attempts` as `rich_text` + a save that writes attempts → fail-fast `"Wrong column type in Notion: \"Attempts\" is rich_text but Leetion needs number…"`; no opaque page write, no PATCH. |
| 5. Regression: matching DB untouched; date only on create | ✅ | Already-correct DB: success, zero database PATCHes, `schemaCreated: []`, no prompt. `buildProperties` gate: `"Date (of first attempt)"` present on create, absent on update (`existingPageId` set). |
| 6. Conservative mapping — never rename/retype/delete | ✅ | Every captured database PATCH across all scenarios is add-only: no `null` property (Notion delete syntax), no `name` key (rename syntax), only `DATABASE_SCHEMA` columns. Static check confirms no null-property payloads in `background.js`. |

## Visual evidence

- `schema-confirm-warning-top.png` — warning block under the Save button: heading
  "Your Notion database is missing columns Leetion uses", the column list with
  duplicate hints ("Date (of first attempt) (date) — existing date columns: Date, Review").
- `schema-confirm-warning-actions.png` — bottom of the same block: the
  "Leetion never renames or deletes your existing columns…" note and the
  Cancel / "Add columns & save" buttons (columns are only created via the confirm button).

## Files in this folder

- `harness.mjs` — the runnable test harness (`node harness.mjs`, exits non-zero on failure)
- `harness-output.txt` — full 41-check output of the passing run
- `schema-confirm-warning-top.png`, `schema-confirm-warning-actions.png` — popup warning UI
- `REPORT.md` — this file

## Notes for Reviewer

- Popup-side wiring was verified by code read (no DOM harness for popup.js):
  `needsSchemaConfirmation` → `showSchemaConfirmation()` (textContent-only, no innerHTML),
  confirm button re-calls `saveToNotion(true)`, cancel shows "Save canceled — no columns
  were added", save button loading state reset in `finally`, and the save-button click
  handler is wrapped (`() => saveToNotion()`) so the click event can't leak into
  `confirmSchemaChanges`. `confirmSchemaChanges === true` is enforced on the message.
- Only `background.js:539` calls the new 3-arg `ensureDatabaseSchema`; no stale 2-arg
  callers remain (grep-verified across all JS).
- Ordering quirk (not an AC violation): on a legacy DB where the save also writes a
  wrong-typed column (e.g. old rich_text "Time Complexity" with a complexity value set),
  the wrong-type fail-fast fires before the missing-columns confirmation, so the user
  fixes the type first and sees the confirm dialog on the next save. Reasonable UX;
  mismatches the save does not write are reported as a non-blocking warning instead.
