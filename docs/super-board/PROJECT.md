# PROJECT.md — Leetion

Context file for super-board lane agents. Read this before touching any card. This file is the source of truth for stack and conventions; `README.md` covers user-facing setup.

## What this app is

A Manifest V3 browser extension (Chrome + Firefox) that saves LeetCode solutions to a user's Notion database in one click. Features: solution snapshots, auto-tagging from LeetCode's problem tags, spaced-repetition review reminders, complexity tracking, rich notes, and local form persistence. Published on the Chrome Web Store and Firefox Add-ons (currently v1.1.5).

## Stack and layout

- Vanilla JavaScript, HTML, CSS. **No framework, no bundler, no npm dependencies** — the repo root IS the extension; files load as-is.
- Layout (flat, root-level):
  - `manifest.json` — MV3 manifest shared by Chrome and Firefox (the `browser_specific_settings.gecko` block carries the Firefox id and min version 112).
  - `popup.html` / `popup.js` / `styles.css` — the extension popup: solution form, snapshots, settings.
  - `background.js` — module-type service worker; owns all Notion API calls (`api.notion.com`) and the spaced-repetition alarms/notifications.
  - `content.js` — content script injected on `leetcode.com/problems/*` and `leetcode.cn/problems/*`; extracts problem metadata and editor code.
  - `onboarding.html` / `onboarding.js` / `onboarding.css` — first-run setup walkthrough.
  - `icons/` — extension icons.
- User credentials (Notion integration token + database id) live in extension storage — never hardcode them, never log them.

## Commands

- `bash build.sh` — packages the extension into `leetion.zip` (the store-upload artifact). Must stay green on every card.
- `node --check <file>.js` — syntax gate for every touched JS file.
- No dev server and no automated test suite. Runtime verification = load the repo folder unpacked via `chrome://extensions` (Developer mode → "Load unpacked").

## Conventions

- Stay MV3-compatible: no persistent background page; background work goes through the service worker, long-lived state through `chrome.storage` and alarms.
- Keep Chrome + Firefox parity: both browsers load the same files. Anything Chrome-only needs a fallback or an explicit note on the card.
- Support both `leetcode.com` and `leetcode.cn` wherever URLs are matched or parsed.
- Version bumps touch `manifest.json` AND `package.json` together (they track the same version).
- Manifest permissions are minimal on purpose (`activeTab, tabs, storage, scripting, alarms, notifications` + the three host permissions). Adding a permission triggers store re-review and a user-facing warning — never add one unless the card explicitly calls for it.
- No runtime network calls other than the Notion API and the LeetCode pages the user is already on.

## QA lane note (no test framework)

There is no Playwright/e2e harness in this repo. QA verifies by:

1. `bash build.sh` succeeds and `node --check` passes on every touched `.js` file.
2. Exercising the card's acceptance criteria in a real Chromium browser (load unpacked) where the environment allows; otherwise a deep code-path review against the ACs.
3. Writing findings and evidence to `docs/super-board/runs/` per card.

## Definition of done (per card and overall)

- Each card's acceptance criteria are the completion contract — do not edit checkboxes to fake completion.
- The extension loads with zero errors on `chrome://extensions` after the change; `bash build.sh` stays green.
- No regression to the save-to-Notion happy path: capture code on a problem page → fill the form → save → the page appears in the user's Notion database.
