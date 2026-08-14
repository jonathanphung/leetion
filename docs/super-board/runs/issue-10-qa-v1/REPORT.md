# QA report — issue #10 · Revisit sets Spaced Repetition to today (v1) — PASS

- **Card:** #10 Revisit button should set Spaced Repetition to today, not today + interval
- **PR:** #13 · branch `issue-10-revisit-sets-today` @ `956b721` · base `main` @ `c5218d0`
- **Date:** 2026-08-10 · Tester lane (super-board wave, QA pass 1)
- **Verdict:** **PASS → Review** — all 7 ACs verified. 432/432 assertions green across
  8 timezone scenarios, plus 6 screenshots from a real headless Chrome run.

---

## How this was tested

PROJECT.md: no test framework, no npm dependencies, no dev server. So QA runs the
**real, unmodified `background.js` and `popup.js`** and mocks only the two
boundaries the extension talks to — `chrome.*` and the Notion HTTP API. Every
line of product code in between is the code that ships.

### 1. Node suite — `suite/test-revisit.mjs` (432 assertions)

```bash
node docs/super-board/runs/issue-10-qa-v1/suite/test-revisit.mjs
```

- `background.js` is evaluated inside a `Function` whose parameters shadow the
  three globals it touches — `chrome`, `fetch`, `Date` — so the file itself is
  never rewritten (`suite/load-background.mjs`).
- Calls go in through **`chrome.runtime.onMessage`**, the popup's real entry
  point, not straight into internal functions.
- `fetch` is a **stateful** Notion double (`suite/notion-mock.mjs`): a PATCH
  mutates a stored page and a later `GET pages/{id}` or database query reads
  that mutation back. This is what lets AC1's *"on the Notion page, not just
  the popup toast"* be answered at the API-contract level — assertions are
  against what the page holds after the write, not against the request body.
- The clock is frozen per scenario at an instant where the **UTC day and the
  local day disagree**, which is exactly the AC4 case. 8 scenarios:

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

  Each runs in its own child process, because a process has to pick its
  timezone before anything reads a `Date`.

### 2. Negative control — the suite must fail on the pre-fix code

A suite that passes on both the broken and the fixed tree proves nothing, so the
identical suite was pointed at `main`'s `background.js`:

```bash
git show main:background.js > /tmp/background.prefix.js
QA_BACKGROUND=/tmp/background.prefix.js \
  node docs/super-board/runs/issue-10-qa-v1/suite/test-revisit.mjs
```

**196 of 376 assertions fail** on pre-fix code — every AC this card owns, and
nothing else (`S7`, the `days: 0` regression section, is 48/48 green on both
trees, which is the correct answer: this card did not change that intent).
Full output in `negative-control/output.txt`. The headline failures:

| Section | Expected (fixed) | Actual (pre-fix) |
|---|---|---|
| S2 · page date after Revisit | `2026-08-10` | `2026-09-30` — **no write at all**, `days` was `undefined` |
| S3 · Revisit with Low = 1 | `2026-08-10` | `2026-08-12` — one interval day became **two local days** |
| S3 · Revisit with High = 7 | `2026-08-10` | `2026-08-18` — 8 local days out |
| S3 · Revisit with interval 0 | `2026-08-10` | `2026-09-30` — the review date was never touched |
| S1 · local-day helper | `2026-08-10` | function does not exist |

The `+1 -> +2 days` row is the clearest statement of the old bug's cost: at
21:00 in New York, `new Date().toISOString()` is already the next UTC day, so
every interval silently landed a day late on top of pointing the wrong
direction to begin with.

### 3. Browser layer — real headless Chrome (`suite/browser/`)

```bash
node docs/super-board/runs/issue-10-qa-v1/suite/browser/server.mjs   # terminal 1
node docs/super-board/runs/issue-10-qa-v1/suite/browser/shoot.mjs    # terminal 2
```

The real `popup.html` / `popup.js` / `styles.css`, with `chrome.runtime
.sendMessage` routed into **the real `background.js`** loaded in the same page
and backed by the same Notion double. The Builder's handoff warned that issue
#1's frozen `chrome-stub.js` still models the old `days`-only contract — this
harness has no hand-written background to drift, so that class of false green
is structurally impossible here.

Screenshots are captured by driving headless Chrome over the DevTools protocol
from Node's built-in `WebSocket` — no npm dependency added. The dark banner at
the top of each shot renders the otherwise-invisible state: the frozen clock,
the local day vs. the UTC day, what the Notion page now holds, and the exact
message the popup sent.

The extension popup is a fixed 400px panel, not a responsive page, so the
standard 3-viewport matrix does not apply; the useful axis here is one shot per
AC state at the popup's real width.

---

## Per-AC results

| AC | Result | Evidence |
|---|---|---|
| **AC1** — Revisit sets Spaced Repetition to today, verified on the page | **PASS** | S2 (7 asserts x 8 TZ): after the write, `GET pages/{id}` returns `{"Spaced Repetition":{"date":{"start":"<local today>"}}}` and the seeded `2026-09-30` is gone; `Done` and the other properties are untouched. Screenshot `02` banner: `Spaced Repetition = 2026-08-10`. |
| **AC2** — toast reads "Reset! Due today" | **PASS** | Screenshot `02` / `03`: green status bar reads **Reset! Due today**. No "Next review in N days" string remains in `popup.js`. |
| **AC3** — independent of the expertise interval | **PASS** | S3 (9 asserts x 8 TZ): `setToday` wins over no `days`, `days:0`, `1`, `3`, `7`, `null`, and over stored intervals of `0/0/0`. Stronger observable in the browser: during the click the popup reads **only `notionApiKey`** from `chrome.storage.sync` (`browser-state.json` -> `storageKeys: ["notionApiKey"]`), so the interval settings are not merely ignored — they are never read. Screenshots `02` (1/3/7) and `03` (0/0/0) are identical in outcome. |
| **AC4** — the user's **local** calendar day | **PASS** | S1 across all 8 scenarios, including UTC-11 and UTC+14, both DST transitions and a year rollover. In 7 of 8 the UTC day differs from the local day and the written value follows the **local** one. Screenshot banners show `local day 2026-08-10` / `UTC day 2026-08-11` with `2026-08-10` written. |
| **AC5** *(revised — see below)* — Review Today leaves Attempts untouched | **PASS** | S4: Attempts stays `3` across two clicks, and the PATCH body carries no `Attempts` property at all; the date is still today. Browser: the popup's sent payload is `{pageId, setToday:true}` and `#input-attempts` still reads **3** after the click. Screenshot `06`: a forced Notion failure leaves the page at `2026-09-30` / `Attempts 3` and surfaces the error. The handler still honours an explicit `attempts` from other callers (save path, manual `+1`). |
| **AC6** — due in the same day's `checkReviews` query | **PASS** | S5: written at 00:05 local, then the real `checkDueReviews()` is run at 00:06, 12:00 and 23:55 local — all three filter on `on_or_before: <local today>`, all three return the page, all three fire the notification. `handleGetStats` counts it as due too. Screenshot `04`: **"You have 1 problem due for review today."** |
| **AC7** — Review Tomorrow unchanged (+1 day) | **PASS** | S6: `days:1` writes local today+1 (correct across both DST transitions and the year rollover), writes **no** `Attempts` property, and the page is **not** in today's due set but **is** in tomorrow's. Screenshot `05`: `Spaced Repetition = 2026-08-11`, `Attempts = 3` (unchanged), payload `{"days":1}`. |

## Gates

| Gate | Result |
|---|---|
| `node --check` on `background.js`, `popup.js`, `content.js`, `onboarding.js` | PASS |
| `bash build.sh` | PASS — `leetion.zip`, 23 files |
| `leetion.zip` carries no `docs/` QA files | PASS — 0 entries |
| Builder's `harness/tz-check.js`, both timezones | PASS — re-run, `ALL CHECKS PASSED` x2 |
| QA suite, 8 timezone scenarios | PASS — 432/432 |
| Negative control on pre-fix `background.js` | 196/376 fail, as required |

Output: `gates-output.txt`, `suite-output.txt`, `browser-output.txt`.

---

## Observations (non-blocking — no AC is affected)

None of these are regressions from this PR; all three predate it and are
recorded so the Reviewer and the board owner can decide, not because QA thinks
this card should absorb them.

1. **`Review Tomorrow` still shrinks to `Tomorrow` after a click.** `popup.js`'s
   `markForReviewTomorrow` `finally` block re-renders the label as `Tomorrow`
   while `popup.html` ships `Review Tomorrow` — the exact static-markup/JS
   mismatch this card fixed on the sibling button, left in place on this one.
   Visible in screenshot `05`. Out of scope: AC7 pins the *behaviour* of Review
   Tomorrow as unchanged, and this is a one-word copy fix better carried by its
   own card.
2. ~~**Staged Attempts and Revisit disagree.**~~ **Resolved** by the AC5 revision
   below: Revisit no longer writes `Attempts` at all, so there is no longer a
   value for the staged count to disagree with.
3. **Quick-button icons are 16px in `popup.html` and 14px in the `popup.js`
   re-render**, so both buttons' icons shrink slightly after their first click.
   Pre-existing and cosmetic.

---

## AC5 revision — 2026-08-13 (post-QA, owner decision)

The board owner changed AC5 after this report was written: **Review Today must
not increment Attempts.** Queuing a problem for review is a scheduling action,
not an attempt at it — the attempt happens later, and is already counted then by
the `+` button, the Attempts field, or the next save. Incrementing on click
inflated the count for anyone who queued a problem and never got to it.

`revisitProblem` in `popup.js` now sends `{pageId, setToday: true}` with no
`attempts` field, and its optimistic `userAttemptCount++` / rollback pair is
gone. `background.js` is unchanged — `updateSpacedRepetition` already skipped
the property when no `attempts` arrives, and still honours one when another
caller sends it (S4 covers that).

Re-verified on 2026-08-13 against the revised code: suite **432/432**
(S4 rewritten, S2/S3/S5 payloads corrected to match what the popup really
sends), `node --check` clean, and all six screenshots regenerated through the
real `popup.js` — every post-click shot now reads `Attempts = 3` with the sent
payload visible in the banner. No other AC moved.

## Scope note — what a live Notion workspace would add

AC1/AC5/AC6 are verified against a stateful Notion double, not a live Notion
database: this worker has no Notion integration token, and QA does not handle
user credentials. The same caveat is on record for issue #2's QA pass. What the
double cannot catch is a Notion-side rejection of the property payload — but
`Spaced Repetition` is already a date property written by the pre-existing save
path with the identical `{date:{start:"YYYY-MM-DD"}}` shape, so this card
changes the *value*, not the shape. Residual risk: low.

## Files in this evidence folder

```
REPORT.md                         this report
assertions.json                   432 machine-readable assertions (fixed tree)
assertions-negative-control.json  376 assertions on the pre-fix tree
suite-output.txt                  full suite run
browser-output.txt                headless-Chrome capture log
gates-output.txt                  node --check / build.sh / zip / builder harness
browser-state.json                per-screenshot DOM + Notion state
01..06-*.png                      screenshots (420x760, the popup's real width)
negative-control/output.txt       the pre-fix run (regenerate with the command above)
suite/                            the suite itself (see the commands above)
```
