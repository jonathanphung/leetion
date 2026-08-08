# QA v2 — issue #1 · Fix Attempts counter

**Verdict: PASS → Review**
Branch `issue-1-fix-attempts-counter` · PR #6 · base `main` @ `0f2a8fa`

QA v1 passed the pre-bounce build. The owner then bounced the card from Done
after testing in Chrome, the Builder reworked the UI placement and changed
Attempts to a *staged* edit, and three ACs were superseded/revised by owner
decision. This pass re-verifies every AC against the **post-bounce** code, in a
real browser, **integrated with the main branch as it stands today**.

---

## What this pass had to do first: integrate main

PR #6 was `MERGEABLE: CONFLICTING` on arrival. Wave-1 PRs #7, #8 and #9 merged
to `main` while this card sat in Done, and all three touch the same functions.
Per the super-board promotion-gate reconciliation rule, QA merged `origin/main`
into the branch so the card is reviewed and merged against the code that will
actually ship, rather than against a three-PR-stale snapshot.

Merge commit: `32d5185`. Every hunk was a union — no behavior from either side
was dropped. One of them was **not** mechanical:

> `#8` added an early `return` in `updatePageContent` for the "no snapshots and
> no notes" path. That return fires *after* the Attempts PATCH has already
> landed, but it did not carry `attempts`. Taken naively, a user who pressed
> "Update in Notion" with nothing but an Attempts edit staged would have written
> the value to Notion and then had the popup keep showing it as *unsaved*,
> because `response.attempts` came back `undefined` and `pendingAttempts` never
> cleared. Resolved with a `withAttempts` wrapper so **every** post-PATCH return
> path reports what the PATCH wrote.

That defect exists only in the naive merge; it never reached a commit. It is
called out because it is the kind of thing a reviewer should look at directly —
see `background.js` in the diff of `32d5185`.

## Test fixtures repaired (QA-owned files, no product code touched)

Two suites went red on the merged tree. Both were fixture gaps, not regressions:

| Suite | Symptom | Cause | Fix |
|---|---|---|---|
| issue-1 background harness | 17/27 failing, every save returning "Wrong column type in Notion" | the fake database reported columns with **no `type`**; #9's new schema inspector reads that as "every column mismatched" and fails the save fast | fake now mirrors the real `DATABASE_SCHEMA` — names *and* Notion types — read back out of the loaded module so it cannot drift again |
| issue-2 cross-device suite | 8/79 failing on snapshot deletion + reconcile | the Notion mock had no `GET pages/{id}` route, so #1's server-fresh Attempts read threw and took the whole save down with it | route added |

After the fixes, all three suites are green on the merged tree — including
issue-2's, which is the real answer to "did #1 regress cross-device sync": **no**.

---

## AC results

| AC | Status | Evidence |
|---|---|---|
| **AC1** — Update increments by exactly 1 **per popup session** | PASS | 3 -> Update -> 4 -> Update again (same session) -> still 4; reopen -> Update -> 5. `browser-session.log` |
| **AC2** — increment computed server-fresh (`GET pages/{id}` immediately before the PATCH) | PASS | harness asserts the GET is *immediately* adjacent to the PATCH, and that a direct Notion edit 7->41 lands 42, not a stale value. `background-harness.log` |
| **AC3** — first-time save still writes Attempts = 1 | PASS | create path POSTs `Attempts: 1`; second save in the same session does not bump past 1. `new-problem-control-hidden-desktop.png` |
| **AC4** — **superseded by owner** — `+` stages instead of writing | PASS as revised | two `+` clicks -> field 7, **zero** background messages, Notion untouched; save then lands exactly 7, not 8. `staged-plus-desktop.png` |
| **AC5** — **superseded by owner** — dead stats row stays reverted | PASS as revised | `#problem-stats` still hidden; `#stat-acceptance` / `#stat-submissions` present again; `popup.html` diff vs main is **+25/-0**, so that row is byte-identical |
| **AC6** — Revisit increments + resets date; Tomorrow leaves Attempts alone | PASS | Revisit 77->78 and date 2026-08-20->2026-09-07; Tomorrow sends no `attempts` key and leaves 78 |
| **AC7** — **revised by owner** — failed write does not corrupt the count | PASS as revised | forced failure: Notion untouched at 3, field keeps 77, still flagged staged, red error status; retry lands 77. `failed-save-keeps-staged-desktop.png` |

Spaced Repetition is never touched by an Attempts write on any of these paths —
asserted byte-identical in the harness (`AC4c`) and confirmed by the Tomorrow
case above.

## Gates

```
issue-1 background harness   27/27 pass    background-harness.log
issue-2 cross-device suite   79/79 pass    regression-issue2-sync.log
issue-4 schema harness       41/41 pass    regression-issue4-schema.log
node --check (4 files)       pass          gates.log
bash build.sh                pass          gates.log
```

Reviewer rerun command (from the branch root):

```bash
node docs/super-board/runs/issue-1-qa-v1/harness/background.qa.test.mjs
node docs/super-board/runs/issue-2-qa-v1/suite/test-sync.mjs
node docs/super-board/runs/issue-4-qa-v1/harness.mjs
node --check popup.js background.js content.js onboarding.js && bash build.sh
```

## Gaps the Builder flagged, now closed

- **Click-away commit was unverified.** The Node popup-harness runs with
  `document.hasFocus() === false`, so the Builder could only dispatch the blur
  event synthetically. Verified here in real Chromium with real focus: type 19,
  do **not** press Enter, click "Update in Notion" — blur fires, the edit stages,
  and the save sends `{attempts: 19, incrementAttempts: false}`. The edit is not
  dropped.
- **Stale screenshots.** `issue-1-qa-v1/*.png` show the pre-bounce UI (count
  under the problem title, `+1` pill). This folder recaptures the shipped UI at
  all three viewports. The v1 images are left in place as history; **treat
  `issue-1-qa-v2/` as the current visual record.**

## Non-blocking observations (recorded, deliberately not bounced)

1. **Staged edit + "Revisit (Reset)" moves the number twice.** With 100 staged,
   Revisit writes 78+1 = 79 to Notion immediately (ignoring the staged value),
   the field keeps showing 100, and the next save lands 100 — discarding
   Revisit's increment. No data loss and the user's explicit value wins, which
   is the documented priority. The Builder disclosed this; it is a narrow
   same-session edge and fixing it is not worth another lane cycle on this card.
2. **`docs/super-board/runs/issue-3-qa-v1/qa-intervals.mjs` is red on `main`
   itself** (verified against a clean `origin/main` worktree, unrelated to this
   branch). Same root cause as the issue-1 fixture: its Notion mock predates
   #9's schema inspector, so no page write ever happens and the interval
   assertions read `undefined`. Spaced repetition itself is fine — this is a
   stale fixture on main and belongs in its own card.
3. **`checkExistingProblem` still swallows errors into `{exists:false}`**
   (`background.js`), the duplicate-page risk named in the issue's Notes. Out of
   this card's blast radius; the issue explicitly says "if touched".

## Verdict

All seven ACs pass as written or as owner-revised. No regressions to
cross-device sync or schema handling on the integrated tree. Card moves
**QA -> Review**.

`human_approves_merge: true` — the Reviewer approves; a human clicks merge.
