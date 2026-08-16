# issue #5 — Builder evidence

Card: [#5 Add a Submissions property that syncs with the real LeetCode submission count](https://github.com/jonathanphung/leetion/issues/5)
Branch: `issue-5-sync-submissions-count`

## What changed

| File | Change |
|---|---|
| `background.js` | `Submissions` added to `DATABASE_SCHEMA` as `{ type: "number", number: { format: "number" } }`, directly after `Attempts`. |
| `background.js` | `checkExistingProblem` returns `submissions` (`null` when the column is absent/empty, so "never synced" is distinguishable from "synced, genuinely 0"). |
| `background.js` | New `updateSubmissions` action + handler: validates the count, checks the column exists via the **existing** `inspectDatabaseSchema`, then PATCHes `Submissions` and nothing else. |
| `content.js` | New `getSubmissionCount` branch on the **existing** dispatcher (the one that already answers `getProblemData`), plus the same-origin `questionSubmissionList` GraphQL pager. |
| `popup.html` / `styles.css` | New `#card-submissions` row: label, read-only `<output>` value, freshness note, "Sync submissions" button. |
| `popup.js` | Slug/host detection on tab check, local sync record (`submissions_sync_<n>`), the `syncSubmissions` flow, and the display/freshness renderer. |
| `README.md` | `\| Submissions \| Number \|` added to the schema table (the #4 invariant — schema and README move together). |

`manifest.json` is **byte-identical** (`git diff manifest.json` is empty). No new
permissions, no new host permissions, no new dependencies.

## Design decisions worth reviewing

**Counting rule and cap.** LeetCode's `questionSubmissionList` has no count
field, so a count means paging. The rule is: **all** submissions for the problem
(accepted and not, re-runs included), page size 20, **hard cap of 5 pages = 100
submissions**. On hitting the cap the popup displays `100+` and the note says the
real total is higher; the number written to Notion is `100`. A capped number is
never presented as exact.

**Fetch runs in the content script, not the service worker.** The request is
same-origin, so the browser attaches the LeetCode session cookie itself — this
behaves identically in Chrome and Firefox, whereas background-context cookie
attachment via host permissions is Chrome-specific. `x-csrftoken` comes from the
readable `csrftoken` cookie. Message flow:
popup → `chrome.tabs.sendMessage` → content script → GraphQL → popup →
`chrome.runtime.sendMessage` → `background.js` → Notion.

**Nothing is written on a failure.** Every failure path returns before the
Notion PATCH: network error, HTTP error, GraphQL error, unrecognised response
shape, mid-paging failure (a partial count is discarded, not written), a
non-numeric count, a missing/mistyped `Submissions` column. `0` is only ever
written when a well-formed response genuinely reported zero submissions.

**Fail closed on schema drift.** The query asks for the minimum (`id`,
`statusDisplay`). If `questionSubmissionList` is missing, `submissions` is not an
array, or `hasNext` is not a boolean, the sync aborts with a visible error rather
than guessing a number from a shape it does not recognise.

**Logged-out is a lazy probe, not a popup-open probe.** The button is live until
the first click; a signed-out response disables it and shows
"Log in to LeetCode to sync submissions." Detecting login state up front would
mean a LeetCode request on every popup open — exactly the silent fetch the
ticket rules out. No console errors on this path and the rest of the popup is
untouched.

**leetcode.cn is excluded, not half-supported.** The card is hidden on `.cn`
pages (popup-side host gate), and the content script refuses the action there
too (defence in depth) — `.cn` runs a different backend.

**`Submissions` is presented as synced, never editable.** It renders as text in
an `<output>`, with no input, no stepper, no `+`. The note under it always states
provenance: `Not synced yet` / `Value stored in Notion · sync to refresh` /
`Synced 5m ago`, so a stale number cannot pass for a live one. Notion is the
source of truth for the value; this browser's `submissions_sync_<n>` record only
supplies the "when", and is dropped when it disagrees with Notion.

**Column creation stays on the #4 path.** `Submissions` is in `DATABASE_SCHEMA`,
so it is created by the existing inspect → confirm → `ensureDatabaseSchema`
flow on save. `updateSubmissions` never creates a column: if it is missing, the
sync fails with *'press "Update in Notion" once and confirm the column list'*.
No second property-creation code path was added.

## Attempts is provably untouched

The sync path never reads or writes `userAttemptCount`, `pendingAttempts`,
`attemptSessionIncremented`, or the `Attempts` property. Asserted mechanically,
not by inspection — harness case **B1** loads the real `background.js` and
asserts the exact PATCH body:

```
{"properties":{"Submissions":{"number":42}}}
```

with explicit assertions that `Attempts` is absent and that the body carries
exactly one property. **A2** additionally pins the `Attempts` schema entry.

## Local verification

`node --check` clean on `background.js`, `popup.js`, `content.js`,
`onboarding.js`. `bash build.sh` → green. `git diff manifest.json` → empty.

`harness/submissions-check.js` loads the **real** `background.js` and the **real**
`content.js` in sandboxes (`chrome`, `fetch`, `window`, `document` injected as
`Function` parameters so they shadow the globals inside each file's scope;
`content.js`'s IIFE wrapper is unwrapped so its internals can be exercised).

```bash
# from the repo root
node docs/super-board/runs/issue-5-build/harness/submissions-check.js
```

**24/24 PASS** (`harness-output.txt`):

| Group | Covers |
|---|---|
| A1–A3 | `Submissions` in `DATABASE_SCHEMA` with the right type; `Attempts` entry unchanged; README table ≡ `DATABASE_SCHEMA`, both directions (#4 invariant). |
| B1–B2 | PATCH carries `Submissions` only (**the Attempts regression assertion**); a genuine `0` is written. |
| B3–B7 | Nothing is written for: non-numeric / negative / string / `NaN` counts, missing `pageId`, missing column, wrong column type, Notion API failure. |
| C1–C5 | Single page, request shape (endpoint, `same-origin`, csrf header, minimal query), multi-page paging with correct offsets, the 5-page/100 cap with `capped: true`, id de-duplication. |
| C6–C7 | Logged out via GraphQL auth error and via HTTP 403 — `signedIn: false`, no count. |
| C8–C11 | Schema drift (4 shapes), mid-paging failure (no partial count), network error, non-JSON response. |
| C12–C14 | `leetcode.cn` makes zero requests; slug falls back to the page URL; a missing csrf cookie still sends a valid request. |

## Left for QA

The harness covers logic, not the live API or the rendered popup. QA still owns:

- **Real LeetCode, logged in**: sync on a problem with <20 submissions and one
  with >20 (paging), confirm the number matches LeetCode's own submissions tab,
  and confirm the value lands in the Notion `Submissions` column.
- **Real LeetCode, logged out**: button disables with the hint, no console
  errors, rest of the popup still works.
- **Cap**: a problem with >100 submissions displays `100+` and writes `100`.
- **Fresh database missing the column**: sync reports the missing column, then
  "Update in Notion" → confirm → sync succeeds.
- **Database that already has a same-named `Submissions` column**: #4's
  similar-column warning behaves, no duplicate column is created.
- **`leetcode.cn`**: the Submissions card is absent.
- **Attempts regression, in the real popup**: sync, then confirm the Attempts
  field, its staged-edit behaviour, and its `+` control are exactly as #1 left
  them, and that Notion's `Attempts` value did not move.
- **Popup screenshots** of: never-synced state, freshly-synced state, capped
  state, logged-out state.
