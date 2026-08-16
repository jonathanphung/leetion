# QA report — issue #12 · "Mark to-do" button (v1) — PASS

- **Card:** #12 Add a "Mark to-do" button on the problem header row to queue an unattempted problem
- **PR:** #16 · branch `issue-12-mark-todo-button` @ `a05d934` · base `main` @ `c56592d`
- **Date:** 2026-08-15 · Tester lane (super-board wave, QA pass 1)
- **Verdict:** **PASS → Review** — all 9 ACs verified. 648/648 Node assertions green
  across 8 timezone scenarios, 72/72 browser assertions green from a real headless
  Chrome run, 9 screenshots. Three non-blocking observations for the Reviewer at the
  bottom; none is an AC failure.

---

## How this was tested

PROJECT.md: no test framework, no npm dependencies, no dev server. So QA runs the
**real, unmodified `background.js` and `popup.js`** and mocks only the two
boundaries the extension talks to — `chrome.*` and the Notion HTTP API. Every
line of product code in between is the code that ships.

### 1. Node suite — `suite/test-todo.mjs` (648 assertions)

```bash
node docs/super-board/runs/issue-12-qa-v1/suite/test-todo.mjs
```

- `background.js` is evaluated inside a `Function` whose parameters shadow the
  three globals it touches — `chrome`, `fetch`, `Date` — so the file itself is
  never rewritten (`suite/load-background.mjs`).
- Calls go in through **`chrome.runtime.onMessage`**, the popup's real entry
  point. `markTodo` is a message action, so this is the only honest way to
  exercise it — the dispatcher in `handleMessage` is part of the code under test.
- `fetch` is a **stateful** Notion double (`suite/notion-mock.mjs`), extended for
  this card with the create path: `POST pages` stores properties **and children**,
  `GET databases/{id}` answers with a real column schema so
  `inspectDatabaseSchema`'s missing / mismatch branches can be driven, and
  `PATCH databases/{id}` performs the column creation. This is what lets
  "confirm all six property values in Notion" be answered against **what the row
  holds after the write**, not against the request body.
- The clock is frozen per scenario at an instant where the **UTC day and the
  local day disagree** — the timezone defect the ticket calls out. 8 scenarios,
  each in its own child process (a process must pick its timezone before
  anything reads a `Date`):

  | Scenario | TZ | Frozen at | Local day | UTC day |
  |---|---|---|---|---|
  | `new-york-evening` | America/New_York (UTC-4) | 2026-08-11T01:00Z | 2026-08-10 | 2026-08-11 |
  | `tokyo-morning` | Asia/Tokyo (UTC+9) | 2026-08-10T22:00Z | 2026-08-11 | 2026-08-10 |
  | `midway-late` | Pacific/Midway (UTC-11) | 2026-08-11T10:00Z | 2026-08-10 | 2026-08-11 |
  | `kiritimati-early` | Pacific/Kiritimati (UTC+14) | 2026-08-10T11:00Z | 2026-08-11 | 2026-08-10 |
  | `utc-control` | UTC | 2026-08-10T12:00Z | 2026-08-10 | 2026-08-10 |
  | `ny-dst-spring` | America/New_York | 2026-03-08T04:30Z | 2026-03-07 | 2026-03-08 |
  | `ny-dst-fall` | America/New_York | 2026-11-01T05:30Z | 2026-11-01 | 2026-11-01 |
  | `ny-year-rollover` | America/New_York | 2027-01-01T02:00Z | 2026-12-31 | 2027-01-01 |

  Sections are isolated: a section that throws records one failure and the run
  continues, so the negative control below reports per-AC coverage instead of
  aborting on the first missing page id.

### 2. Negative control — the suite must fail on pre-fix code

A suite that passes on both the broken and the fixed tree proves nothing, so the
identical suite was pointed at `main`'s `background.js`:

```bash
git show main:background.js > /tmp/background.prefix.js
QA_BACKGROUND=/tmp/background.prefix.js QA_ASSERTIONS=assertions-negative-control.json \
  node docs/super-board/runs/issue-12-qa-v1/suite/test-todo.mjs
```

**320 of 544 assertions fail** on pre-fix code — every AC this card owns — while
**`REG` (the untouched save path) is 56/56 green on both trees**, which is the
correct answer: this card did not change the normal save. Full output in
`negative-control/output.txt`.

| AC | pre-fix | fixed | what pre-fix does instead |
|---|---|---|---|
| AC3 create | 0/24 | 24/24 | `markTodo` is an unknown action → `{success:false, error:"Unknown action: markTodo"}`; no row at all |
| AC3a review date | 8/16 | 16/16 | no row, so no date |
| AC3b Attempts = 0 | 0/8 | 8/8 | no row |
| AC3d Done written false | 0/16 | 16/16 | no row |
| AC3f metadata | 0/40 | 40/40 | no row |
| AC5 popup contract | 8/40 | 40/40 | response carries no `pageId` / `attempts` / `todo` |
| AC6 round-trip | 0/32 | 32/32 | `checkExisting` has no `hasFirstAttemptDate`; nothing to backfill |
| AC7 due today | 8/48 | 48/48 | nothing queued, so the alarm sees nothing |
| AC9 duplicate guard | 32/56 | 56/56 | the pre-create re-check does not exist |
| REG normal save | 56/56 | 56/56 | unchanged, as intended |

Where pre-fix "passes" (e.g. AC3c "first-attempt date absent", part of AC8) it
passes **by vacuity** — there is no row, so the property is trivially absent.
That is expected in a negative control; the failing rows are the load-bearing
ones.

### 3. Browser layer — real headless Chrome (`suite/browser/`, 72 assertions)

```bash
node docs/super-board/runs/issue-12-qa-v1/suite/browser/server.mjs   # terminal 1
node docs/super-board/runs/issue-12-qa-v1/suite/browser/shoot.mjs    # terminal 2
```

The real `popup.html` / `popup.js` / `styles.css`, with `chrome.runtime
.sendMessage` routed into **the real `background.js`** loaded in the same page and
backed by the same Notion double. The popup→background contract for the new
`markTodo` action is exercised, not re-implemented, so this harness cannot drift
the way a hand-written fake background can.

Screenshots are captured by driving headless Chrome over the DevTools protocol
from Node's built-in `WebSocket` — no npm dependency added. The dark banner at
the top of each shot renders the otherwise-invisible state: the frozen clock, the
local day vs. the UTC day, every property the Notion row now holds, how many rows
were actually created (vs. how many `POST /pages` attempts were made), and the
exact message the popup sent.

The extension popup is a **fixed 400px panel** (`styles.css` → `body { width:
400px }`), not a responsive page, so the standard 1920/1024/375 viewport matrix
does not apply. The useful axis is the popup at its real width across the layout
range that stresses AC1: the widest realistic header (`#2846` + `HARD`) and the
narrowest (`#1` + `EASY`).

---

## Per-AC results

| AC | Result | Evidence |
|---|---|---|
| **AC1** — compact, right-aligned, on the header row; no wrap, no badge squeeze at 400px | **PASS** | Measured geometry, both ends of the range. Widest header: number `[25,64]`, badge `[72,122]`, button `[288,375]`, header `[25,375]` — button right edge **exactly** the header's content edge (375 = 375), vertical centres identical (`cy` 218 for badge and button), header 23px tall = its tallest child, so one line. `white-space: nowrap` computed on the button; `#app` and the problem card have `scrollWidth == clientWidth` (no horizontal overflow) and `body` is still 400px. **Cross-shot control:** shots `01` and `02` are the same problem with and without the button — badge width (50px), number width (39px), badge x (72) and header height (23) are identical, so the button squeezes nothing. Screenshots `01`, `08`, `02`. |
| **AC2** — shown only when the problem has no Notion row | **PASS** | Shot `01`: lookup resolves "not found" → button visible, 0 rows created just by showing it. Shot `02`: same problem seeded in Notion → `btn-mark-todo` carries `hidden`, save button already reads "Update in Notion". The button starts hidden in the markup and is only revealed by the resolved `checkExisting` response, so it never flashes for a saved problem. |
| **AC3** — the queued row's six property values | **PASS** | Node S1 (13 asserts × 8 TZ) reads them back off the stored page: `Spaced Repetition` = **local** today (and ≠ the UTC day in the 7 scenarios where they differ); `Attempts` = `0`; `Date (of first attempt)` **absent**; `Done` = `false` **and present** (written explicitly, not left to a Notion default); `My Expertise` **absent**; title / `S No.` / `Level` / `Question Link` / `Tag` populated. Browser shot `03` banner: `Spaced Repetition=2026-08-10 · Attempts=0 · Done=false · First attempt=(empty) · Expertise=(empty)` with the UTC day showing `2026-08-11`. |
| **AC4** — no solution content | **PASS** | Node S2: the created page's `children` array is empty, no `blocks/*` append call is made, and the property set is **exactly** `[Attempts, Done, Level, Question, Question Link, S No., Spaced Repetition, Tag]` — asserted as a whole set, so a future stray property fails the test. `Remark`, `Alternative Method Tags`, `Time Complexity`, `Space Complexity` individually absent. Shot `03`: `body blocks=0`. |
| **AC5** — popup reflects the new entry | **PASS** | Node S3 pins the response contract the popup depends on (`pageId`, `attempts: 0`, `updated: false`, `todo: true`, `contentUpdated: false`). Shot `03` proves the UI transition: button hidden, save button reads **"Update in Notion"**, Quick Actions card ("Review Tomorrow" / "Review Today") visible, attempts field shows `0`, Done toggle reset to unchecked to match the row, green toast **"Marked to-do - due for review today"** with `status-success`. |
| **AC6** — the first real "Update in Notion" | **PASS** | Node S5 (18 asserts × 8 TZ) runs the full round-trip: queue → `checkExisting` (reports `attempts: 0`, **not** 1, and `hasFirstAttemptDate: false`) → update with the payload popup.js actually sends. Result: `Attempts` **0 → 1** (server-fresh, not double-counted), `Date (of first attempt)` **backfilled to the local day**, expertise / Done / Remark / complexity written, page body filled. A second update in the same session leaves `Attempts` at 1 and never rewrites the backfilled date. Browser shot `04` shows it end to end with a real click: `Attempts=1 · First attempt=2026-08-10 · Expertise=High · body blocks=4`, payload `backfillFirstAttemptDate:true, incrementAttempts:true`. The PR states the deliberate answer the ticket demanded, in a property table. |
| **AC7** — due in the same day's `checkReviews` | **PASS** | Node S6: after `markTodo`, the real `checkDueReviews()` fires exactly one notification titled "LeetCode Review Due" reading **"You have 1 problem due for review today."**, and the query it sent filters `on_or_before: <local today>`. `handleGetStats` counts it as `dueForReview: 1`. Browser shot `05` banner: `hourly alarm You have 1 problem due for review today.` |
| **AC8** — failure path, no half-created state | **PASS** | Node S7: a forced Notion 500 on `POST /pages` → `{success:false, error:"…"}`, **zero rows** in the database, no `pageId` handed back; a retry after the outage creates exactly one row still holding `Attempts = 0`. Node S8 extends this to the shared guards: missing columns → `needsSchemaConfirmation` with nothing written until the user confirms (and confirming still queues it unattempted, with today's local date); a wrong column type on `Attempts` → fail-fast error naming the column, no row. Browser shot `06`: 3 `POST /pages` attempts (notionRequest's retries), **0 rows**, button still visible, **re-enabled**, label restored to "Mark to-do", red `status-error` toast, save button still "Save to Notion", Quick Actions still hidden. Shot `09` covers the unconfigured case (see observation 2). |
| **AC9** — duplicate guard | **PASS** | Node S4: marking to-do on a problem already in Notion creates **no** second row, returns `{alreadyExists:true, pageId}`, and leaves the existing row's `Attempts` (4) and review date (`2026-12-01`) untouched. The stale-popup race is covered separately: a row that appears *after* the popup's lookup is still caught by the background's re-check by problem number immediately before the create. Browser shot `07` drives that race for real — the button is on screen, the click produces **0 `POST /pages` attempts**, and the popup adopts the existing row (`Attempts=2`, `Spaced Repetition=2026-09-30` preserved). |

## Gates

| Gate | Result |
|---|---|
| `node --check popup.js` | **PASS** |
| `node --check background.js` | **PASS** |
| `node --check content.js` | **PASS** |
| `node --check onboarding.js` | **PASS** |
| `bash build.sh` | **PASS** — `Done! Created leetion.zip` |
| Node suite (fixed tree) | **648/648** |
| Node suite (pre-fix `main`) | **224/544** — 320 failures, `REG` 56/56 on both |
| Browser suite | **72/72** |

Raw output: `gates-output.txt`, `suite-output.txt`, `browser-output.txt`,
`negative-control/output.txt`. Machine-readable: `assertions.json`,
`assertions-negative-control.json`, `browser-state.json`.

## Visual evidence

| # | Shot | What it shows |
|---|---|---|
| 01 | `01-button-visible-new-problem.png` | AC1/AC2 — unsaved problem, button right-aligned on the header row |
| 02 | `02-button-hidden-existing-entry.png` | AC2 — same problem already in Notion: no button |
| 03 | `03-marked-todo.png` | AC3/AC4/AC5 — the queued row and the popup transition |
| 04 | `04-update-after-attempt.png` | AC6 — the first real update backfills the date, Attempts 0 → 1 |
| 05 | `05-due-today-alarm.png` | AC7 — the hourly check sees it as due the same day |
| 06 | `06-failure-retry.png` | AC8 — failed create: error surfaced, button still clickable, no row |
| 07 | `07-duplicate-guard.png` | AC9 — a row that raced in is adopted, not duplicated |
| 08 | `08-layout-short-number.png` | AC1 — the narrow end of the layout range |
| 09 | `09-notion-not-configured.png` | AC8 — Notion unconfigured: nothing to half-create |

---

## Observations for the Reviewer (non-blocking — no AC fails on these)

1. **The duplicate guard depends on a read that swallows its own errors.**
   `checkExistingProblem` catches everything into `{exists: false}`
   (background.js:426-429), and the pre-create re-check calls it. So the guard
   protects the case the AC names (a row exists and the query says so) and the
   stale-popup race, but if the lookup *fails* — transient 5xx, expired token —
   while the create then succeeds, a second row is possible. The window is
   narrow (the same outage would normally take the create down too, and
   `notionRequest` retries 3×), and closing it means changing
   `checkExistingProblem`'s error contract, which is out of scope for this card.
   Flagging so it is a decision rather than an oversight.

2. **With Notion unconfigured the button is never offered at all.**
   `checkExistingEntry` returns early when there is no API key or database id
   (popup.js:985-990), so `setMarkTodoVisible(true)` never runs and the header
   shows nothing — while the "Save to Notion" button *is* shown and routes the
   user to settings. Verified in shot `09`: 0 rows, 0 requests, button hidden;
   forcing the handler does surface "Configure Notion settings first" and opens
   the settings view, so the guard inside `markTodo` is correct but defensive
   only. This satisfies AC8 (no half-created state, and the error path works),
   but the two entry points behave differently for a fresh install. Product
   call, not a defect.

3. **`firstAttemptDateMissing` is not to-do-specific.** Any pre-existing row with
   an empty "Date (of first attempt)" — e.g. one created by hand, or by the
   duplicate-date-column mess of #4 — gets that date backfilled to today on its
   next update. The code comment says this is intended ("this update IS the
   first recorded attempt"), and it is the only way to get a value onto a
   dateless row given `buildProperties` writes it on create only. Worth a
   conscious nod from Review rather than discovering it later.
