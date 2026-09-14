# QA v1 — issue #20 · Spaced Repetition switch stages until "Update in Notion"

**Verdict: PASS.** 131/131 assertions green (94 in a real browser, 37 at the
background-contract layer), every one of AC1–AC12 covered by at least one
observable test, and 35 of those assertions demonstrably fail on `main`.

| | |
|---|---|
| Branch | `issue-20-stage-spaced-repetition-toggle` @ `1685af7` |
| PR | #21 |
| Base | `main` @ `1f53d2a` |
| Rebuild counter | v1 (first pass) |
| Clock in all fixtures | frozen at `2026-08-16T02:00:00Z` |

## How this was tested

There is no test framework in this repo (PROJECT.md: "no dev server and no
automated test suite"), so QA here means building the harness. Two layers,
both driving the **real product files** — nothing under `popup.js` /
`background.js` is re-implemented or rewritten for the test:

**1. Browser layer — `suite/browser/`.** Real headless Chrome over the
DevTools protocol, loading the real `popup.html` + `popup.js` + `styles.css`.
`chrome.runtime.sendMessage` is routed into the real `background.js`
(evaluated in a `Function` whose `chrome` / `fetch` / `Date` parameters shadow
the globals it touches), and `fetch` under the background is a **stateful**
Notion double, so "what the Notion page holds" is a read-back rather than a
request log. 13 scenarios, 94 assertions, one screenshot each.

This layer is the right one for this card in particular. AC1 is a claim that a
message which *used to* be sent is **no longer sent** — only a real message
router can tell "not sent" apart from "sent and ignored", and only a stateful
Notion double can tell "no write reached the page" apart from "a write reached
it and was overwritten later".

**2. Background-contract layer — `suite/test-stage.mjs`.** The new
`scheduleSpacedRepetitionToday` flag, the precedence it was given, and the
three positional argument lists it has to survive
(`saveToNotion` → `updatePageContent` → `buildProperties`), plus a static
audit of `popup.js` for AC1/AC11. 37 assertions.

**Timezone.** The clock is frozen at an instant where the local day
(`2026-08-15`, America/Chicago) and the UTC day (`2026-08-16`) disagree. Every
"today" assertion therefore fails on a UTC regression, not just on a
wrong-by-days one — and each screenshot's banner prints both days so the
reader can check it by eye.

## Coverage — one observable test per AC

| AC | What was observed | Where |
|---|---|---|
| **AC1** — flipping sends nothing | After a real click on the switch, a full second of quiet: zero write messages, zero `updateSpacedRepetition` messages, **zero Notion PATCHes**, stored date byte-identical. Plus a static audit that `stageSpacedRepetition`'s body contains no `sendMessage` and that `toggleSpacedRepetition` is gone. | `02`, `03` · node AC1 |
| **AC2** — staged state is visible | `#spaced-repetition-row` carries `.is-staged`, and `getComputedStyle` on the switch reports a real `2px solid` outline — the CSS rule is asserted, not just the class. Hint reads "Will clear on update" / "Will schedule on update". | `02`, `04` |
| **AC3** — staged off → `{"date": null}` | The save sends `clearSpacedRepetition: true`; the Notion page then holds exactly `{"date": null}` (emptied, not missing); the hourly alarm raises nothing. | `03` · node AC3 |
| **AC4** — staged on → today + interval | Low/Medium/High resolve through 1/3/7. **Expertise switched to High *after* staging still writes today + 7**, proving the interval is resolved at save time. Asserted as a local calendar day, not UTC's. | `04`, `05` · node AC4 |
| **AC5** — interval 0 | Chosen behaviour (fall back to today) verified end to end: staged ON at 0/0/0 sends `scheduleSpacedRepetitionToday: true` and the page gets **today**, so the switch is not left claiming a date that does not exist. The negative half is verified too: an *ordinary* save on the same level does **not** set the flag and leaves the stored date alone (issue #3 intact). Precedence pinned at the `buildProperties` level: clear > scheduleToday > days. | `06`, `07` · node AC5 |
| **AC6** — restaging to stored state | off → on on a scheduled problem drops `.is-staged`, the hint reverts to "Due date set", and the following save sends `clearSpacedRepetition: false` — no no-op write is queued and the problem is still scheduled. | `08` |
| **AC7** — save success / failure | A **failed** save (the page PATCH forced to 500 through all three `notionRequest` retries) leaves the flip staged, the switch showing the user's pending choice, and the Notion date untouched. The retry then lands and drops the staged flag. A successful save resyncs the switch and drops the flag. | `09`, `09b`, `03`, `04` |
| **AC8** — popup-open hydration | Asserted at the top of **every one of the 13 scenarios** before anything is touched: a scheduled problem reads on, a cleared one reads off, nothing staged, hint describing stored state. | all 13 |
| **AC9** — quick actions unchanged | Review Today still writes immediately (`setToday`, today's local date); Review Tomorrow writes today + 1. Both discard a staged flip. **The regression the AC is really about is covered explicitly**: after Review Today discards a staged "off", the *next* save sends `clearSpacedRepetition: false` and the date the user just asked for survives. | `10`, `11` · node AC9 |
| **AC10** — unstaged off stays out | A cleared problem, nothing staged, plain "Update in Notion": still sends the clear, page still `{"date": null}`, alarm still silent. Issue #11's guarantee survives. | `12` · node REG |
| **AC11** — session-only decision | Stated in the PR as session-only, and verified: after staging a flip and triggering a form-draft write, the persisted `form_state_1` payload carries **no** spaced-repetition key, and neither `persistFormState` nor `loadPersistedFormState` mentions one. | `02` · node AC11 |
| **AC12** — gates | `node --check` clean on all four JS files, `bash build.sh` green (88 KB zip). | `gates-output.txt` |

Screenshot ↔ AC mapping is also machine-readable in `assertions.json`
(`scenarios[].why`, and `checks[].ac` on all 94).

## Negative control — the tests are load-bearing

The identical suites were run against `main` (pre-fix product files, via
`PRODUCT_ROOT` / `BACKGROUND` / `POPUP`):

| Layer | On the branch | On `main` |
|---|---|---|
| Browser (94 assertions) | 94 pass | **28 red** |
| Background contract (37) | 37 pass | **7 red** |

Red on `main`: all 8 AC1 assertions (the old switch fired a PATCH the moment
it moved), all 10 AC2 assertions (no `.is-staged`, no staged hint), AC5's
fallback, AC6's restage, AC7's failure retention, AC9's staged-discard
precondition, and the `buildProperties` precedence block. Output in
`negative-control/`.

AC3, AC4, AC8 and AC10 pass on `main` too — deliberately. Those are the
guarantees the card had to **preserve**, so they are regression guards, not
proof of new behaviour, and it is correct that they are green on both sides.

## Regression run — the merged cards

Node-layer suites for every merged card, all on this branch:

| Card | Result |
|---|---|
| #1 Attempts | 27/27 |
| #2 Cross-device sync | 79/79 |
| #10 Revisit → today | ALL CHECKS PASSED |
| #11 Clear Spaced Repetition | 73/73 |
| #12 Mark to-do | 656/656 |

Two suites (#3, #4) have pre-existing failures. Both were run on `main` as
well and produce **byte-identical counts** — #3: 29 pass / 38 fail on both;
#4: 39/42 on both. They encode semantics that merged cards #10–#12 have since
changed. **Not caused by this card**, and out of scope for it; worth a
follow-up card of its own.

### The issue-#11 browser fixture is superseded, not broken by a bug

The card's Notes flagged `docs/super-board/runs/issue-11-qa-v1/suite/browser/boot.js`
as the known regression surface, and the Builder repeated the flag. It was
re-run on this branch and the flag is confirmed — log in
`issue-11-fixture-rerun.txt`. Four of its nine demos no longer demonstrate
what their captions claim, because this card deliberately changed the
semantics they encode:

| Demo | Caption | What it now shows |
|---|---|---|
| `02-cleared` | "switching off empties the Notion date" | page still holds `2026-09-30`; the clear is staged, not written |
| `04-re-enabled-today` | "switching back on re-queues it for TODAY" | page still `{"date": null}` |
| `05-failure-rollback` | "a Notion error reverts the switch" | there is no longer a write to fail |
| `09-clear-drops-highlight` | clearing stops the notification | alarm still says "1 problem due" — the clear is unwritten |

**Decision (Tester's call): leave that folder alone.** It is the dated
evidence record of a card that has already merged; rewriting its screenshots
and captions to the new semantics would falsify what QA actually observed in
August for #11. What matters is that #11's *durable* regression net — the
background contract suite `test-clear.mjs` — is green (73/73), and that its
user-visible guarantee is re-asserted under the new rules by AC10 and the two
`REG (#11)` blocks here. A `SUPERSEDED.md` was added **alongside** the #11
evidence so nobody re-runs that fixture and reads its output as a regression.

## Notes for the Reviewer

- **The evidence directory is committed to the branch** (screenshots + suites
  + both negative-control runs), so the inline images in the PR/issue comments
  resolve.
- **Viewport is 420×980, not the 1920/1024/375 ladder** in the super-board
  Tester contract. This UI is a browser-action popup: Chrome renders it at the
  width `popup.html` declares (~400px) and never at a desktop or tablet width,
  so three viewports would be three copies of the same column on a field of
  empty page. Deliberate deviation, and the same one the #10/#11/#12 QA lanes
  took.
- **One harness change worth naming.** `notion-mock.mjs` was carried forward
  from #11 with one addition: `failNextWith` now takes an optional
  `match(endpoint, method)`. Without it the AC7 failure test was a false
  negative — a save probes the database schema before it PATCHes the page, so
  an unfiltered "fail the next 3 calls" was spent on the probe's retries while
  the write under test quietly succeeded, and the harness reported a
  *successful* save as a failed one. Caught and fixed before the pass.
- **Nit, not a finding, not fixed.** The Attempts control also carries a
  `title` tooltip ("Unsaved — press Update in Notion to apply"); the switch has
  no equivalent. The visible hint text does the same job, so parity is real
  where it counts. Mentioned only so the Reviewer does not have to rediscover
  it.

## Re-running this suite

```bash
# gates
node --check popup.js && node --check background.js && bash build.sh

# background contract (37 assertions)
node docs/super-board/runs/issue-20-qa-v1/suite/test-stage.mjs

# browser layer (94 assertions + 13 screenshots)
node docs/super-board/runs/issue-20-qa-v1/suite/browser/server.mjs &
node docs/super-board/runs/issue-20-qa-v1/suite/browser/shoot.mjs

# negative control (expects RED)
PRODUCT_ROOT=<a checkout of main> PORT=8231 \
  node docs/super-board/runs/issue-20-qa-v1/suite/browser/server.mjs &
PORT=8231 CDP=9354 OUT_DIR=docs/super-board/runs/issue-20-qa-v1/negative-control \
  node docs/super-board/runs/issue-20-qa-v1/suite/browser/shoot.mjs
```

## Evidence index

| File | What |
|---|---|
| `01-open-scheduled.png` … `12-unstaged-off-stays-out.png` | one screenshot per scenario, banner showing the invisible state |
| `assertions.json` | all 94 browser assertions, per-scenario and per-AC |
| `assertions-node.json` | all 37 background-contract assertions |
| `browser-output.txt` / `suite-output.txt` | console output of both green runs |
| `gates-output.txt` | AC12 + the merged-card regression run |
| `issue-11-fixture-rerun.txt` | the superseded #11 fixture, re-run on this branch |
| `negative-control/` | both suites against `main`: 28 + 7 red |
| `suite/` | the harness itself |
