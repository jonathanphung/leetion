# Partly superseded by issue #20 — read before re-running `suite/browser/`

Added 2026-08-22 by the issue-#20 QA lane. **Nothing in this folder was
edited.** It is the dated record of what QA observed for issue #11, and it
stays that way.

## What still holds

- `suite/test-clear.mjs` — the background contract for a cleared review date
  (a cleared problem never matches the due query and never notifies). This is
  #11's durable regression net and it is **green on the #20 branch, 73/73**.
  Keep running it.
- `suite/notion-mock.mjs`, `suite/load-background.mjs` — still good; the #20
  suite is built on copies of them.

## What no longer holds

`suite/browser/boot.js` drives the "Spaced Repetition" switch and then waits
for an `updateSpacedRepetition` message. Issue #20 turned that switch into a
**staged** form control: flipping it now writes nothing, and the change only
reaches Notion on "Update in Notion". Four of the nine captured demos
therefore no longer demonstrate what their captions claim:

| Screenshot | Caption | What it shows on `main` after #20 |
|---|---|---|
| `02-cleared.png` | "switching off empties the Notion date" | date untouched; the clear is staged, not written |
| `04-re-enabled-today.png` | "switching back on re-queues it for TODAY" | date still empty |
| `05-failure-rollback.png` | "a Notion error reverts the switch" | there is no write left to fail |
| `09-clear-drops-highlight.png` | clearing stops the review notification | the alarm still fires — the clear is unwritten |

The other five (`01`, `03`, `06`, `07`, `08`) still read correctly.

A re-run of this fixture on the #20 branch is captured at
`../issue-20-qa-v1/issue-11-fixture-rerun.txt` if you want to see it rather
than take this file's word for it.

## Where those guarantees live now

Issue #11's user-visible promise — *a problem the user took out of the review
rotation stays out* — is re-asserted under the new semantics by the #20 suite:

- `../issue-20-qa-v1/` → **AC10** (`12-unstaged-off-stays-out.png`): a cleared
  problem, nothing staged, plain "Update in Notion" — still cleared, alarm
  still silent.
- `../issue-20-qa-v1/suite/test-stage.mjs` → the two `REG (#11)` blocks,
  including one that keeps the now-callerless `clear` arm of
  `updateSpacedRepetition` honest.
