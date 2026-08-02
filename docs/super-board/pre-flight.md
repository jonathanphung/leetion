# super-board pre-flight — leetion

Seeded during onboard on 2026-08-02. Every unchecked item is a halt gate for `super-board run`. Re-run `super-board lint` after writing tickets to regenerate this file.

## 🔑 Credentials the loop will need
- [✓] None in-repo — user-side Notion tokens live in extension storage, never in the codebase. Cards must not require a live Notion workspace; Notion API behavior is verified against developers.notion.com and code review.

## 🛠 Tools the loop will need
- [✓] gh CLI authenticated as `jonathanphung` (scopes: project, repo)
- [✓] jq 1.8.2
- [✓] node v25.8.1
- [✓] Dynamic workflows enabled in the orchestrator session (Workflow tool available)
- [✓] `node --check` passes on `.claude/workflows/super-board-wave.js`
- [✓] `super-board-wave-plan.sh` runs against the live board (returns an empty wave — no cards yet)
- [✓] `bash build.sh` packages `leetion.zip` — Info-ZIP is absent in Git Bash on this machine, so build.sh falls back to the installed 7-Zip (`C:\Program Files\7-Zip\7z.exe`). Verified 2026-08-02: artifact contains exactly the extension files (10 root files + icons/), no VCS/docs/tooling files, forward-slash entry paths.

## 🌐 Environment
- [✓] Board reachable: project #9 "leetion" (https://github.com/users/jonathanphung/projects/9) — Status columns match the full variant (+ Backlog staging column)
- [✓] Project #9 linked to the `jonathanphung/leetion` repository
- [✓] Repo `jonathanphung/leetion` cloned at `C:/Users/jonat/repos/leetion`, clean on `main`, push + admin access verified
- [✓] Commit email set to the GitHub noreply address (email-privacy pushes safe)

## Lint summary
- Not yet run — the board has 0 cards. Write tickets into Ready (or Backlog), then run `super-board lint` to check every issue for a `## Goal` + testable `## Acceptance Criteria` before `super-board run`.
