# QA report — issue #11 · Clear Spaced Repetition for a single problem (v1) — PASS

- **Card:** #11 Add a control to clear Spaced Repetition for a single problem (toggle pill like Done)
- **PR:** #15 · branch `issue-11-clear-spaced-repetition` @ `4cf6d51` · base `main` @ `c56592d`
- **Date:** 2026-08-15 · Tester lane (super-board wave, QA pass 1)
- **Verdict:** **PASS → Review** — all 8 ACs verified. 73/73 Node assertions green
  against the real `background.js`, plus 9 screenshots from a real headless
  Chrome run driving the real `popup.js`. Two judgement calls flagged for the
  Reviewer at the bottom.

---

## How this was tested

PROJECT.md: no test framework, no npm dependencies, no dev server. So QA runs the
**real, unmodified `background.js` and `popup.js`** and mocks only the two
boundaries the extension talks to — `chrome.*` and the Notion HTTP API. Every
line of product code in between is the code that ships. The harness is grown
from issue #10's, so a regression in #10's Revisit semantics would surface here
as well as in its own suite.

### 1. Node suite — `suite/test-clear.mjs` (73 assertions)

```bash
node docs/super-board/runs/issue-11-qa-v1/suite/test-clear.mjs
```

- `background.js` is evaluated inside a `Function` whose parameters shadow the
  three globals it touches — `chrome`, `fetch`, `Date` — so the product file is
  never rewritten (`suite/load-background.mjs`).
- Calls go in through **`chrome.runtime.onMessage`**, the popup's real entry
  point, not straight into internal functions.
- `fetch` is a **stateful** Notion double (`suite/notion-mock.mjs`): a PATCH
  mutates a stored page and a later `GET pages/{id}` or database query reads
  that mutation back. So AC1's *"verified on the Notion page"* is answered
  against what the page holds after the write, not against the request body.
  The double models the one Notion semantic this card rides on — **a date
  comparator like `on_or_before` never matches an empty date property** — and
  it serves the exact `DATABASE_SCHEMA` from `background.js`, so a schema-probe
  bail would show up as a failure rather than a silent pass.
- The clock is frozen at `2026-08-16T02:00:00Z`, where the **local day
  (2026-08-15) and the UTC day (2026-08-16) disagree** — inherited from #10 so
  "re-queue for today" is provably the *user's* today.

### 2. Negative control — the suite must fail on pre-fix code

A suite that passes on both the broken and the fixed tree proves nothing, so the
identical suite was pointed at `main`'s `background.js`:

```bash
git show main:background.js > negative-control/background.prefix.js
QA_BACKGROUND=.../negative-control/background.prefix.js \
  node docs/super-board/runs/issue-11-qa-v1/suite/test-clear.mjs
```

**34 of 73 assertions fail** on pre-fix code — every AC this card owns, and
nothing else. Full output in `negative-control/output.txt`. Headline failures:

| Section | Expected (fixed) | Actual (pre-fix) |
|---|---|---|
| S1 · PATCH count for a clear | 1 | **0** — `clear` is not an intent, so nothing is sent at all |
| S1 · stored property | `{"date":null}` | `{"date":{"start":"2026-09-30"}}` — the date survives |
| S2 · `clear` + `setToday` | `null` | `2026-08-15` — `clear` is silently ignored |
| S3 · hydration | `"2026-09-30"` / `null` | `undefined` — the field does not exist |
| S4 · save with the flag | `{"date":null}` | `{"date":{"start":"2026-08-18"}}` — **the exact AC6 bug: the save re-adds a date** |
| S5 · due filter | `and:[is_not_empty, on_or_before]` | bare `on_or_before` |
| S5 · alarm after clearing everything | 0 notifications | **1** — nothing was ever cleared |
| S7 · forced Notion failure | `success:false` | `success:true` (`skipped`) — no request was made to fail |

The 39 that stay green on both trees are the right ones: `days: 0` still leaves
the date alone (#3), `setToday`/`days: 1` still write local today / today+1
(#10), and the create path still schedules from the interval. This card did not
change those intents, and the suite says so.

### 3. Browser layer — real headless Chrome (`suite/browser/`)

```bash
node docs/super-board/runs/issue-11-qa-v1/suite/browser/server.mjs   # terminal 1
node docs/super-board/runs/issue-11-qa-v1/suite/browser/shoot.mjs    # terminal 2
```

The real `popup.html` / `popup.js` / `styles.css`, with `chrome.runtime
.sendMessage` routed into **the real `background.js`** loaded in the same page
and backed by the same Notion double. Clicks are real user clicks on the
`.toggle-switch` label — which matters for AC7, because the browser flips the
checkbox itself before the handler runs, so the rollback has real state to undo.

The extension popup is a fixed 400px panel, not a responsive page, so the
standard 3-viewport matrix does not apply; the useful axis is one shot per state
at the popup's real width. The dark banner renders the otherwise-invisible
state: the frozen clock, local vs. UTC day, the **raw** stored property (so
`{"date":null}` is distinguishable from "never had the property"), the switch,
its hint, whether Quick Actions is hidden, and what the popup actually sent.

Full per-shot state in `browser-state.json`; console transcript in
`browser-output.txt`.

---

## Per-AC results

| AC | Result | Evidence |
|---|---|---|
| **AC1** — the control clears the date in Notion, writing `{"Spaced Repetition": {"date": null}}` | **PASS** | S1 (12 asserts): the PATCH body is *exactly* `{"properties":{"Spaced Repetition":{"date":null}}}` — one request, nothing else in it; after the write `GET pages/{id}` returns `{"date":null}`, the seeded `2026-09-30` is gone, and `Attempts`/`Done`/`Level` are byte-identical. Screenshot `02`: banner reads `"Spaced Repetition" = {"date":null}`, sent `{"clear":true}`. |
| **AC2** — reflects real state on popup open, sourced from the hydrating page load | **PASS** | S3: `checkExisting` returns `spacedRepetition` = the date for a scheduled entry, `null` for an emptied one, and `null` for a page that never had the property. Screenshots `01` (entry with a date → switch **ON**, hint "Due date set") and `03` (**a genuine reopen**: the popup boots fresh against an already-emptied page → switch **OFF**, hint "No reviews"). `03` is the important one — it is the popup's own start-up path, not a leftover in-page state. |
| **AC3** — turning it back on re-sets a date; the rule is stated in the PR | **PASS** | PR states the rule: **on writes TODAY**, matching #10's Revisit. S6 step 4 and screenshot `04`: the switch sends `{"setToday":true}`, the page becomes `2026-08-15` — the **local** day, while UTC is already `2026-08-16` — and the hourly alarm immediately reports "You have 1 problem due for review today." Never blank, including when the expertise interval is `0`. |
| **AC4** — hidden/disabled until the problem exists in Notion | **PASS** | The switch lives inside `#card-quick-actions`, which ships `hidden` and is only unhidden by `checkExistingEntry` on a hit. Screenshot `06` (`seed=none`, problem genuinely absent from the mock DB): `quickActionsHidden=true` — the whole card, switch included, is not rendered, and the save button still reads "Save to Notion". `toggleSpacedRepetition` also reverts on a null `existingPageId` as a second line of defence. |
| **AC5** — a cleared problem stops appearing in the `checkReviews` due query and its notification | **PASS** | S5: the filter is now `and:[{is_not_empty:true},{on_or_before:<local today>}]`. Replaying that exact filter against a 5-page database returns **only** `page-due` + `page-overdue` — the cleared page and a never-scheduled page are provably excluded, not merely absent from a count — and the notification reads "You have 2 problems due for review today." Clear both through the real handler and the alarm fires **zero** notifications. `handleGetStats` agrees (`dueForReview: 0`). Screenshots `02`/`07`/`09` banners: `hourly alarm (no notification)`. |
| **AC6** — a later plain Save/update does not silently re-add a review date | **PASS** | S4: with `clearSpacedRepetition` the save writes `{"date":null}` even though `spacedRepetitionDays: 3` was also sent; **the same save without the flag writes `2026-08-18`**, which is what proves the flag is doing the work. Also holds when the interval is `0`. `buildProperties` asserted directly, including that 4-arg callers are unchanged. Screenshot `07` is the whole thing through the UI: switch OFF → "Update in Notion" → payload carries `spacedRepetitionDays:3, clearSpacedRepetition:true` → page stays `{"date":null}`. |
| **AC7** — a Notion error surfaces via `showStatus` and the control reverts | **PASS** | S7: forced 500 and forced 401 both return `{success:false, error:"…"}` and leave the page at `2026-09-30`. Screenshot `05` is the user-visible half: a real click flips the checkbox, the write fails, and the switch is back **ON** with hint "Due date set" while a red `status-error` toast reads "Notion is unavailable" — the Notion page still holds `{"date":{"start":"2026-09-30"}}`. No clear is shown that did not happen. |
| **AC8** — toasts match existing quick-action wording | **PASS** | "Review cleared!" (`02`) and "Review set for today!" (`04`), both `status-success`, alongside the existing "Review set for tomorrow!" and "Reset! Due today" (`08`). Same voice, same length, same status classes. Error path uses the plain Notion message in `status-error`, as the other quick actions do. |

### Card Notes/Constraints — also verified

| Constraint | Result | Evidence |
|---|---|---|
| `days: 0` keeps its #3 meaning; clearing does not repurpose it | **PASS** | S2: `days:0` alone leaves `2026-09-30` untouched and sends **no** PATCH at all (`skipped:true`). `clear` is a separate, higher-precedence intent — it beats `setToday`, `days:7`, and both together. |
| Clearing wins over a stale `quick-btn-success` highlight (issue #10 interaction) | **PASS** | Screenshot `09`: click "Review Today" (highlight becomes `{revisit:true}` — recorded in `browser-state.json` as `successBeforeClear`), then switch off → highlight is `{revisit:false, tomorrow:false}` and the page is `{"date":null}`. The reverse direction too — screenshot `08`: "Review Today" on a cleared problem flips the switch back **ON**. |
| Layout at popup width | **PASS** | Screenshots `01`–`09` at the popup's real 400px. The switch sits under the two review buttons behind a hairline rule, label left, "Due date set"/"No reviews" hint right — no collision, no wrap, no overflow. The Builder's choice to keep it out of the "Mark as Done" row (already holding the Attempts control) is borne out. |
| Markup follows the existing toggle convention | **PASS** | `input.toggle-checkbox` + `label.toggle-switch` + `span.toggle-label`, identical to `#input-done`. No new permissions; `manifest.json` untouched; no browser-specific API, so Chrome/Firefox parity holds. |

## Gates

| Gate | Result |
|---|---|
| `node --check background.js popup.js content.js onboarding.js` | **PASS** (4/4) — `gates-output.txt` |
| `bash build.sh` | **PASS** — "Done! Created leetion.zip" (artifact removed, not committed) |
| `manifest.json` / `package.json` version parity | **PASS** — both `1.1.5`, untouched by this card |
| Node suite | **PASS** — 73/73 |
| Negative control | **PASS** — 34/73 fail on pre-fix code (the suite has teeth) |
| Headless Chrome capture | **PASS** — 9/9 shots settled and captured |

---

## For the Reviewer

Two things worth a deliberate look. Neither blocks the merge, and neither is a
defect QA can demonstrate — they are judgement calls that belong to Review.

**1. `is_not_empty` on the due query is a new dependency on the notification
path.** The double models Notion's filter semantics, not Notion. If a real
Notion rejected `and:[{date:{is_not_empty:true}}, {date:{on_or_before:…}}]`,
`checkDueReviews` would throw and **every** user's review notifications would
stop silently — a much larger blast radius than this card. The construct is
standard (a flat `and` of two property filters; `is_not_empty` is a documented
date condition), so the risk is low, and the PR itself explains the clause is
belt-and-braces: `on_or_before` alone already excludes empty dates, which the
suite confirms at the semantic level. If the Reviewer wants zero added risk on
the notification path, dropping the `is_not_empty` clause is a one-line change
that keeps AC5 green — S5 asserts the exclusion behaviour independently of the
filter shape. **Not verified against live Notion** (no credentials in this
environment); flagged rather than assumed.

**2. The behaviour change the PR body already flags is real, and QA confirms
it.** For an **existing** entry whose date is empty for a reason other than this
switch — expertise interval `0` per #3, a manual Notion edit, a page predating
the property — "Update in Notion" now writes `date: null` where it previously
would have scheduled a review (S4's "clear + interval 0" case). Net effect is
usually a no-op (empty stays empty), it is visible in the UI before the save,
and one click undoes it. It is also the only reading consistent with AC6. Worth
a conscious accept rather than discovering it later.

Everything else the card asked for is verified end to end, including the manual
round-trip it specified — set → clear → reopen → re-enable — run twice: once
through the message router in S6, once through the real popup UI in screenshots
`01`–`04`.
