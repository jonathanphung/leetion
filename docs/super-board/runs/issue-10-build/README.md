# issue #10 — Builder evidence

Card: [#10 Revisit button should set Spaced Repetition to today, not today + interval](https://github.com/jonathanphung/leetion/issues/10)
Branch: `issue-10-revisit-sets-today`

## What changed

| File | Change |
|---|---|
| `background.js` | New `localDateString(date?)` / `localDateInDays(days)` utilities — the local-calendar-day primitive. |
| `background.js` | `updateSpacedRepetition` takes an explicit `setToday: true` intent; `days` keeps its old meaning; `days: 0` still means "leave the date untouched". |
| `background.js` | All five `new Date().toISOString().split("T")[0]` sites moved to the local helper (two write sites, the `checkDueReviews` due query, the `handleGetStats` due count, and the first-attempt date). |
| `popup.js` | `revisitProblem` sends `setToday: true`, no longer resolves an expertise interval, toast is `Reset! Due today`. |
| `popup.html` / `popup.js` | Button copy `Revisit (Reset)` → `Review Today` in both spots (static markup + the `finally` re-render), tooltip → `Set review date to today`. |

## Why the whole file moved off UTC, not just the Revisit path

AC6 requires the reset problem to appear in the same day's `checkReviews` query.
That query (`on_or_before: today`) has to compute "today" the same way the write
does — leaving it on the UTC day would make an AC1-correct write invisible to the
alarm for a user east of UTC. The same argument applies to the save path
(`buildProperties`) and the stats due-count: if one side is UTC and the other is
local they disagree for part of every day, in opposite directions per hemisphere
of the date line.

## Local verification

`bash build.sh` → green. `node --check` → clean on `background.js`, `popup.js`,
`content.js`, `onboarding.js`.

`harness/tz-check.js` loads the **real** `background.js` in a sandbox (`chrome`,
`fetch` and `Date` are injected as `Function` parameters so they shadow the
globals inside the file's scope), freezes the clock at an instant where the UTC
day and the local day disagree, and asserts the exact JSON body that reaches the
Notion `PATCH`.

```bash
# from the repo root — negative UTC offset (the AC4 case)
TZ_NAME=America/New_York ISO_NOW=2026-08-11T01:00:00Z \
  EXPECT_TODAY=2026-08-10 EXPECT_TOMORROW=2026-08-11 \
  node docs/super-board/runs/issue-10-build/harness/tz-check.js background.js

# positive UTC offset (the mirror-image bug: due query would miss the card)
TZ_NAME=Asia/Tokyo ISO_NOW=2026-08-10T22:00:00Z \
  EXPECT_TODAY=2026-08-11 EXPECT_TOMORROW=2026-08-12 \
  node docs/super-board/runs/issue-10-build/harness/tz-check.js background.js
```

Both runs: **10/10 PASS** (20 assertions total). Covered:

- `localDateString()` / `localDateInDays(0|1)` return the local calendar day.
- `setToday: true` writes local today and sets `Attempts` in the same PATCH.
- `setToday: true` wins over `days: 0` **and** over `days: 7` — the interval is
  never consulted (AC3).
- `days: 1` (Review Tomorrow) still writes today + 1 (AC7).
- `days: 0` with no `setToday` still leaves the date untouched; with nothing else
  to write it still skips the request entirely (no regression to the
  disabled-interval semantics or the clear-button intent #11 needs).

Note: `TZ` must be set via `TZ_NAME` and applied inside the script — an
inherited `TZ` env var does not reach Node on Windows.

## Left for QA

- Real-Notion verification of AC1 (date on the page, not just the toast), AC5
  (Attempts +1 and the displayed count), AC6 (card appears in the hourly
  `checkReviews` due query the same day).
- Popup screenshots of the renamed button and the new toast.
- `docs/super-board/runs/issue-1-qa-v1/harness/popup-harness/chrome-stub.js` is
  frozen issue-#1 evidence and still models the old `days`-only contract — if QA
  reuses that harness it needs a `setToday` branch; it is not wired into
  anything today.
