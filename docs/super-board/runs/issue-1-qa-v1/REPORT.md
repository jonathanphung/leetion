# QA report — issue #1 · v1 · PASS

**Card:** Fix Attempts counter: increment on update, visible count, manual +1
**PR:** #6 · branch `issue-1-fix-attempts-counter` @ 721ed98 (Builder commit)
**Lane:** Tester (super-board full variant) · 2026-08-03
**Verdict:** ✅ all 7 ACs pass at the level verifiable in this environment (see Method + Caveat).

## Method

Per `docs/super-board/PROJECT.md` QA-lane note (no test framework in repo; runtime
verification = real browser or deep code-path review), this run used a two-layer
harness against the REAL, unmodified extension sources on the branch:

- **Layer A — background.js contract tests** (`harness/background.qa.test.mjs`):
  loads `background.js` in a Node `vm` with a stubbed `chrome.*` and a fake
  `api.notion.com` fetch that records every request in order and keeps page
  state. Drives the registered `onMessage` listener exactly as the popup does.
  **23/23 assertions pass** (`background-tests.log`).
- **Layer B — popup UI tests in real Chromium**: `harness/popup-harness/server.mjs`
  serves the real `popup.html` + `popup.js` + `styles.css` with
  `chrome-stub.js` injected first (fake background mirroring the Layer-A-verified
  contract; message log on `window.__qa`). Driven interactively in a Chromium
  browser; screenshots captured with headless Chrome at the standard viewports.

## Gates

| Gate | Result |
|---|---|
| `node --check popup.js` | PASS |
| `node --check background.js` | PASS |
| `bash build.sh` | PASS (`leetion.zip` created) |

## Per-AC results

| AC | Check | Result | Evidence |
|---|---|---|---|
| AC1 | +1 per popup session: update #1 sends `incrementAttempts:true` (3→4); update #2 same session sends `false` (stays 4); reopen popup → shows 4, update sends `true` again (→5) | ✅ | Layer B message log + display assertions |
| AC2 | Server-fresh: `GET pages/{id}` is the call **immediately** before the PATCH; write = read+1 (7→8); direct Notion edit (→41) preserved as 42, not stale-overwritten; repeat update omits `Attempts` from PATCH entirely | ✅ | Layer A `background-tests.log` (AC2/AC2b/AC1-backend) |
| AC3 | First save: `POST pages` body has `Attempts=1`; response `attempts:1`; popup shows 1 and stats row appears; same-session update after create does NOT increment | ✅ | Layer A AC3 + Layer B new-problem flow (`new-problem-desktop.png` = pre-save state) |
| AC4 | "+1" visible for existing entries; click sends lightweight `updateAttempts` (`{apiKey,pageId}` only); backend PATCH body property keys === `["Attempts"]`; **Spaced Repetition byte-identical** before/after; display updates in place (5→6) without reopening; button disabled in flight | ✅ | Layer A AC4 + Layer B; `desktop.png` |
| AC5 | `#problem-stats` unhidden for existing entries; dead `#stat-acceptance` / `#stat-submissions` spans REMOVED from the DOM (no "--" anywhere); row hidden for not-yet-saved problems | ✅ | `desktop.png` / `tablet.png` / `mobile.png` vs `new-problem-desktop.png` |
| AC6 | Revisit → `updateSpacedRepetition {days:30, attempts:7}`: display 6→7, date reset (2026-08-20 → 2026-09-02); Tomorrow → `{days:1}` with **no** `attempts` key: count unchanged | ✅ | Layer A AC6 + Layer B message log |
| AC7 | Forced `updateAttempts` failure: optimistic bump observed mid-flight (6→7), display **rolled back to 6**, red error status shown (`status-error`); backend returns `{success:false,error}`; Notion value untouched | ✅ | Layer A AC7 + Layer B delayed-response probe; `error-rollback-desktop.png` |

## Screenshots

- `desktop.png` (1920×1080) — existing entry: stats row "ATTEMPTS: 3" + "+1" button, Update in Notion.
- `tablet.png` (1024×768), `mobile.png` (375×667) — same state, layout intact.
- `error-rollback-desktop.png` — AC7 settled state: count rolled back, red error status visible.
- `new-problem-desktop.png` — problem not yet in Notion: stats row hidden, "Save to Notion".

## Caveat

Not exercised against a **real** Notion database — no Notion credentials exist in
this environment (and QA must not handle real user tokens). PROJECT.md's QA-lane
note sanctions the code-path/harness fallback. Residual risk is limited to
Notion-side API-shape drift, not extension logic: Layer A pins the exact request
sequence and bodies against the documented Notion v1 endpoints the code already
uses in production.

## Observations (non-blocking, no AC violated)

1. **Partial-failure retry edge:** in `updatePageContent` the Attempts PATCH lands
   before the content-block rebuild. If the rebuild then throws, the popup sees
   `success:false`, the session flag stays unset, and a retry Update increments
   again (+2 total for the session). Inherent to Notion's non-atomic API; the
   issue's notes accept read-then-PATCH adjacency as the mitigation. Not worth a
   bounce.
2. `revisitProblem` still writes the popup-side `userAttemptCount+1` rather than a
   server-fresh value — pre-existing behavior, out of AC scope (AC6 only requires
   increment + date reset), and the popup count is now seeded from Notion at open
   and refreshed after every save, so the staleness window is small.
3. `checkExistingProblem` error-swallowing (`{exists:false}` on error) is explicitly
   out of this card's scope per issue notes; overlaps card #2.

## Repro

```bash
node docs/super-board/runs/issue-1-qa-v1/harness/background.qa.test.mjs
node docs/super-board/runs/issue-1-qa-v1/harness/popup-harness/server.mjs &
# open http://localhost:8123/harness.html          (existing entry; window.__qa hooks)
# open http://localhost:8123/harness.html?new=1    (first-save scenario)
# open http://localhost:8123/harness.html?demo=fail-plus  (AC7 auto-demo)
```
