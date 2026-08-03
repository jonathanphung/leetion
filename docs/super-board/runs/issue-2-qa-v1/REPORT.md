# QA report — issue #2 · Cross-device sync (v1) — PASS

- **Card:** #2 Cross-device sync: hydrate snapshots/notes from Notion, stop clobbering on second machine
- **PR:** #8 · branch `issue-2-cross-device-sync` @ `396dc31`
- **Date:** 2026-08-03 · Tester lane (super-board wave 1, QA pass 1)
- **Verdict:** PASS — all 7 ACs verified; 79/79 automated assertions green; visual two-profile verification green.

## How this was tested

The repo has no test framework (PROJECT.md), so QA runs the **real, unmodified
`popup.js` and `background.js`** against mocked boundaries only
(`chrome.*`, `fetch` -> in-memory Notion):

1. **Automated suite** — `node docs/super-board/runs/issue-2-qa-v1/suite/test-sync.mjs`
   - background.js imported as a module (its real `onMessage` handler serves all calls);
     popup.js executed in per-profile Node `vm` contexts with a minimal DOM double.
   - "Machines" = separate chrome.storage backings sharing one mock Notion cloud.
   - 79 assertions across 12 sections (S0-S11), output in `test-output.txt`,
     machine-readable in `assertions.json`.
2. **Visual harness** — real Chromium (headless Chrome 2-profile run over
   `suite/serve.mjs` + `suite/harness-boot.mjs`): the actual popup.html/styles.css UI,
   real event listeners, mock cloud persisted in `localStorage` across page loads.
   Screenshots below. (Real-extension load with a live Notion workspace was not
   available headlessly; the harness mocks ONLY `chrome.*` + the Notion HTTP layer —
   every line of product JS in between is the shipped code.)
3. **Gates** — `node --check` popup.js/background.js/content.js PASS ·
   `bash build.sh` PASS · `leetion.zip` verified to contain no `docs/` QA files.

## Per-AC results

| AC | Result | Evidence |
|----|--------|----------|
| AC1 hydrate snapshot UI from Notion on empty local list (+`codeBlocks` key fix) | PASS | S2 (7 asserts) + `checkExisting returns codeBlocks`; screenshots `desktop/tablet/mobile.png`, `ac1-profile-b-hydrated-full.png` |
| AC2 fresh profile B "Update in Notion" keeps both solutions | PASS | S3 + S4 (guard with zero local snapshots, incl. editor-preview-not-written); `ac2-profile-b-after-update-desktop.png`, `ac2-cloud-after-update.png`, `notion-after-b-update.json` |
| AC3 draft freshness gate (`last_edited_time` vs draft timestamp) | PASS | S5 both directions (13 asserts); `ac3-stale-draft-notion-wins.png`, `ac3-fresh-draft-wins.png` |
| AC4 reconciled state persists; stale list cannot resurrect deletions | PASS | S7: B deletes solution 2 + saves -> stale machine A hydrates to 1 and its save does NOT resurrect (`notion-after-stale-machine-save.json`) |
| AC5 Attempts stays Notion-backed, identical across machines | PASS | S6: attempts=5 written once, two fresh profiles both read 5 |
| AC6 snapshots NOT in `chrome.storage.sync` | PASS | S11: 0 sync writes across every flow; static audit: no sync.set touches `snapshots_`/`form_state_` |
| AC7 E2E: A saves code+notes+expertise -> fresh B matches with no manual step | PASS | S2 (snapshots, notes, remark, expertise, complexity, attempts all match on open) + visual run |

Also covered: >100-block pagination hydration (S10, 60 solutions), lone
question-type snapshot can no longer wipe/blank Solution(s) (S9), unsynced local
WIP snapshots survive reconcile and question snapshots stay local (S8),
create-path happy save (S1, PROJECT.md definition of done).

## Screenshots

| File | What it shows |
|---|---|
| `profile-a-seeded-desktop.png` / `profile-a-seeded-full.png` | Machine A after seeding 2 snapshots + notes + High expertise and saving |
| `desktop.png` / `tablet.png` / `mobile.png` (1920x1080 / 1024x768 / 375x667) | **Fresh machine B, popup just opened**: SAVED SOLUTIONS (2) hydrated from Notion, complexity O(n)/O(1) |
| `ac1-profile-b-hydrated-full.png` | Machine B full form: snapshots, tags, complexity, expertise High, notes "A notes", remark — all from Notion |
| `ac2-profile-b-after-update-desktop.png` | Machine B after pressing "Update in Notion" |
| `ac2-cloud-after-update.png` | Mock cloud state after B's update: **both** solutions + notes intact |
| `ac3-stale-draft-notion-wins.png` | Stale local draft loses: form shows Notion values |
| `ac3-fresh-draft-wins.png` | Newer local draft wins: form keeps draft values |

## Observations (no action required for this card)

1. **Legacy migration caveat (documented by Builder, confirmed by S8):** local
   snapshots saved by pre-fix versions carry no `synced` flag, so reconcile
   treats them as unsynced local work and preserves them. In the one-time window
   where such a snapshot was deleted from Notion on another machine before this
   machine first runs the new code, it reappears on the next save. This is the
   deliberate "never silently drop user code" trade-off; after one save the list
   is flagged and deletion propagation holds (S7).
2. **"Mark as Done" defaults to checked** in popup.html (`checked` attribute) —
   pre-existing on `main`, unchanged by this PR; verified it syncs consistently
   (A saves true -> B hydrates true).
3. Hydrated snapshot timestamps come from the H3 heading date (day precision) —
   snapshot cards on machine B show "12:00 AM" times. Cosmetic, per the PR's
   stated metadata policy; falls back to page `last_edited_time` for non-English
   locale headings.

## Repro commands

```bash
node docs/super-board/runs/issue-2-qa-v1/suite/test-sync.mjs   # 79 assertions, exit 0
node --check popup.js && node --check background.js && node --check content.js
bash build.sh
# visual harness (optional):
node docs/super-board/runs/issue-2-qa-v1/suite/serve.mjs 8123
# then open http://127.0.0.1:8123/qa-harness.html?profile=A&reset&auto=seed
# then     http://127.0.0.1:8123/qa-harness.html?profile=B
```
