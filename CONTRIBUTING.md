# Contributing to Leetion

Thanks for wanting to help. Leetion is source-available, not open source, so
please read the [LICENSE](LICENSE) and the CLA below before you start.

## Keep pull requests small

This is the rule that matters most here. Leetion is maintained by one person in
spare time, and a codebase stays healthy only if every change can be understood
on its own.

**One PR should do one thing.** If you cannot describe the change in a single
sentence without using the word "and", split it.

| | Target | Hard stop |
| --- | --- | --- |
| Files touched | 1–3 | more than 8 |
| Lines changed | under 150 | more than 400 |
| Distinct changes | 1 | more than 1 |

A small PR gets reviewed in a day. A 900-line PR that fixes a bug, renames some
variables, reformats a file, and adds a feature sits unreviewed for weeks and
usually gets declined, because there is no way to accept the good part without
the rest.

If your work is genuinely large, open an issue and propose a sequence of small
PRs that each leave the extension working. Refactors go in their own PR,
separate from behavior changes, always.

Things that make a PR hard to review, in rough order of how much they hurt:

- Reformatting or re-indenting code you did not otherwise change
- Renaming things as a side effect of a different fix
- Bundling an unrelated "while I was in there" cleanup
- Changing behavior and moving code between files in the same commit

None of these are bad work. They are just separate PRs.

## Contributor License Agreement

By opening a pull request against this repository, you agree that:

1. **You wrote it.** The contribution is your own original work, and you have
   the right to submit it. It is not copied from a project under a license that
   would restrict its use here, and it is not owned by an employer who has not
   authorized the contribution.
2. **You assign it.** You assign to Neel Bansal all right, title, and interest
   in the contribution worldwide, including copyright, for the full term of
   those rights. This lets Leetion be relicensed, sold, or distributed
   commercially without needing to track anyone down for permission.
3. **You keep the right to use it.** You retain a non-exclusive right to use
   your own contribution for any purpose. Assigning it here does not stop you
   using your own ideas or code elsewhere.
4. **It is provided as-is.** You make no warranty about the contribution, and
   you are not liable for it.

There is nothing to sign. Opening the pull request is your agreement. The PR
template has a checkbox to confirm you have read this.

If you cannot agree to the assignment in point 2, open an issue describing the
fix instead. A clear bug report is a real contribution.

## Before you write code

Open an issue first for anything beyond a typo or a one-line fix. It takes two
minutes and avoids the case where a PR is declined because the feature does not
fit the direction of the project.

Good first contributions:

- Bug reports with reproduction steps
- Scraper fixes when LeetCode changes their DOM (this breaks most often)
- Notion API edge cases: rate limits, oversized pages, unusual schemas
- Accessibility and keyboard navigation in the popup

## Setting up locally

There is no build step and there are no dependencies. The code that ships is
the code in this repository.

**Chrome**

1. Go to `chrome://extensions`
2. Turn on Developer mode
3. Load unpacked, and select this folder
4. After editing, hit the reload icon on the Leetion card

**Firefox**

1. Go to `about:debugging#/runtime/this-firefox`
2. Load Temporary Add-on, and select `manifest.json`
3. Reload from the same page after editing

To produce a store zip, run `./build.sh`. It excludes `content/`, git files, and
docs. Delete any existing `leetion.zip` first, since `zip` updates an archive
rather than replacing it.

## How the pieces fit

| File | Role |
| --- | --- |
| `manifest.json` | Permissions, entry points, icon sizes. Read this first |
| `popup.html` / `styles.css` | The popup UI |
| `popup.js` | Popup logic, LeetCode scraping, form state |
| `background.js` | Every Notion API call, review alarms, notifications |
| `content.js` | Drawing overlay injected into LeetCode pages |
| `onboarding.*` | First-run setup wizard |

Notion calls belong in `background.js`. The service worker is the only context
allowed to reach `api.notion.com`, and it survives the popup closing.

The Notion column names live in one place, `DATABASE_SCHEMA` in
`background.js`. Missing columns are created automatically on save, so add new
fields there rather than assuming the user's database already has them.

## Code style

Match the file you are editing. Specifically:

- Vanilla JavaScript. **No dependencies and no build step will be accepted.**
- Two-space indentation, double quotes, semicolons. Prettier defaults
- JSDoc comment above anything non-obvious, matching the existing headers
- `console.log` messages are prefixed `Leetion:`
- Keep unrelated reformatting out of your diff. A whitespace-only change across
  a whole file makes the real change impossible to review

## Testing

There is no automated test suite. Test manually and say what you tested in the
PR:

1. A problem you have never saved, so a fresh Notion page is created
2. The same problem again, so the existing page is updated
3. A problem with the Question toggle on, confirming the Question section
   survives a re-save
4. Multiple snapshots in different languages
5. Both an empty editor and a long solution, over 2000 characters

If your change touches the Notion write path, check the resulting page in Notion
rather than trusting the success toast.

## Things that will be declined

- Adding npm packages, bundlers, or a build step
- Analytics, telemetry, or any network call to a host other than
  `api.notion.com` and LeetCode
- Changing the onboarding template URL or the extension branding
- Broadening `permissions` or `host_permissions` without a stated reason
- Large refactors that arrive without a prior issue discussion

## Reporting a security issue

Do not open a public issue for anything involving the Notion API key or user
data. Email the maintainer directly and give it a reasonable window before
disclosing.
