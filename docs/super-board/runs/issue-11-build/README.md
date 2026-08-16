# issue #11 — Builder evidence

Card: [#11 Add a control to clear Spaced Repetition for a single problem](https://github.com/jonathanphung/leetion/issues/11)
Branch: `issue-11-clear-spaced-repetition`

## The two decisions the card asked the Builder to make

**1. Toggle pill, not a Quick Actions button.** The card allowed either. The
toggle won because the control is a *state* ("is this problem in the review
rotation?"), not an *action* — and the state is already knowable from the page
load, so a switch can show it truthfully on open. A button could clear but
could never answer "is it cleared right now?".

It is placed in the **Quick Actions card**, not the "Mark as Done" row. The
card flagged that row as a candidate; it is already full — `.attempts-control`
sits at its right end on `margin-left: auto`, and a second 44px switch + label
would collide with it inside the 400px popup. The Quick Actions card is also
the honest home: the two buttons there write the same Notion property this
switch clears, and that card is already gated on `existingPageId` (`#card-quick-actions`
stays `hidden` until `checkExistingEntry` finds the page), which satisfies AC4
without new gating code.

**2. Turning it back on writes TODAY**, not today + the expertise interval.
This follows issue #10's Revisit reasoning: an explicit user gesture that means
"I want to see this again" should not be silently deferred by an interval that
may be a week out — or 0, which for Low/Medium/High-disabled levels would write
nothing at all and leave the switch on with a blank date, failing AC3. The
expertise interval keeps owning the *save* path, where the question is "when
should I next see this?". Practically: off → clear, on → due today, and the
next ordinary save reschedules from the interval as usual.

## What changed

| File | Change |
|---|---|
| `background.js` | `updateSpacedRepetition` takes an explicit `clear: true` intent → `{"Spaced Repetition": {date: null}}`. Highest precedence over `setToday`/`days`; returns `cleared: true`. |
| `background.js` | `buildProperties` takes `clearSpacedRepetition` (5th arg) → writes `date: null` instead of scheduling. Threaded through `saveToNotion` and `updatePageContent`. |
| `background.js` | `checkExistingProblem` returns `spacedRepetition` — the stored date or `null` — so the popup can hydrate the switch. |
| `background.js` | `checkDueReviews`' filter is now `and: [is_not_empty, on_or_before]`. |
| `popup.html` | `.toggle-row.quick-actions-toggle` inside `#card-quick-actions`: `#input-spaced-repetition` + `#spaced-repetition-hint`. |
| `styles.css` | `.quick-actions-toggle` (hairline rule above the switch) and `.toggle-hint`. |
| `popup.js` | `toggleSpacedRepetition` handler, `setSpacedRepetitionToggle` / `isSpacedRepetitionOn`, hydration in `checkExistingEntry`, `clearSpacedRepetition` on the save payload, and a resync of the switch after every write. |

`days: 0` is untouched and still means "reviews disabled for this expertise
level — leave the stored date alone" (issue #3). The card was explicit that
clearing must not be expressed by repurposing it, and the save path's `> 0`
guard still depends on that meaning.

## Why the `is_not_empty` guard on the due query

Notion's `on_or_before` already skips empty dates, so AC5 holds without it. It
is written out anyway because the AC is a *contract* ("a cleared problem never
notifies") that otherwise lives only in Notion's filter semantics — nothing in
this repo would catch a future change to that query that reintroduced the
match. The harness asserts the filter shape, so the contract is now pinned.

## Local verification

`bash build.sh` → green; the artifact is 23 files with no docs/harness leakage.
`node --check` → clean on `background.js`, `popup.js`, `content.js`,
`onboarding.js`.

`harness/clear-check.js` loads the **real** `background.js` in a sandbox
(`chrome`, `fetch`, `Date` injected as `Function` parameters so they shadow the
globals inside the file's scope, same technique as issue #10's `tz-check.js`),
freezes the clock, and asserts the exact JSON body that reaches Notion.

```bash
# from the repo root
node docs/super-board/runs/issue-11-build/harness/clear-check.js background.js
```

**13/13 PASS** — full output in `harness/clear-check-output.txt`. Covered:

| AC | Assertion |
|---|---|
| AC1 | `clear: true` PATCHes exactly `{"Spaced Repetition": {"date": null}}` and reports `cleared: true` |
| AC1 | `clear` wins over a `setToday`/`days: 7` riding along in the same message |
| AC1 | `clear` + `attempts` land in one PATCH |
| AC2 | `checkExistingProblem` returns `"2026-08-20"` for a scheduled page and `null` for an emptied one |
| AC5 | the due query's filter is `and: [is_not_empty, on_or_before: today]` |
| AC6 | `buildProperties(..., clear=true)` writes `date: null` **even with a non-zero interval** |
| AC6 | regression: `clear=false` + interval 3 still schedules today+3 |
| AC6 | regression: `days: 0` without the flag still omits the property entirely |
| — | regression: `setToday` → today, `days: 1` → tomorrow, `days: 0` alone → request skipped |

`harness/layout-preview.html` is a self-contained render (real `styles.css`
inlined) of the Quick Actions card in both switch states plus the untouched
"Mark as Done" row, for checking the 400px popup width without loading the
extension. Both states fit on one line; the Attempts control is unaffected.

## Behaviour change the Reviewer should look at deliberately

AC6 says a later plain Save must not re-add a date to a cleared problem. Notion
stores no "who emptied this" bit, so the popup cannot tell *user cleared it*
from *never had one*. Both read as **off**, and the save honours the switch.

Consequence: for an existing entry whose "Spaced Repetition" was already empty
for some other reason — expertise interval set to 0 (issue #3), a manual edit
in Notion, a page predating the property — "Update in Notion" no longer
schedules a review where it previously would have. That is the only reading
consistent with AC6, and it is not silent: the switch shows the state on open
and one click puts the problem back in the rotation. New pages
(`existingPageId` null) are untouched — the flag is never sent for a first save.

## Not verified by the Builder (QA lane)

The round-trip against a **real Notion database** — set → clear → reopen popup
→ re-enable — and the failure path (revoke/blank the API key mid-toggle, assert
the switch snaps back and `showStatus` shows the error). Both need live
credentials, which the Builder does not have. AC7's revert logic is in
`toggleSpacedRepetition`'s `else`/`catch` branches; AC8's strings are
`"Review cleared!"` / `"Review set for today!"` / `"Failed to update"`, matching
the existing `"Review set for tomorrow!"` / `"Reset! Due today"` house style.
