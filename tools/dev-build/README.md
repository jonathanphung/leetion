# dev-build

Builds a personally-signed XPI so the working tree can be installed permanently
in Firefox-derived browsers, rather than re-loaded as a temporary add-on on
every restart.

Zen enforces extension signing at the Gecko level — `xpinstall.signatures.required`
is a build-time flag there, so `about:config` cannot turn it off. The only
permanent install path is a signed XPI, and AMO signs unlisted add-ons for
private distribution automatically.

## Usage

```bash
tools/dev-build/restage.sh   # copy working tree -> .dev-build/src, patch manifest, lint
tools/dev-build/sign.sh      # upload to AMO, sign, park the XPI in .dev-build/
```

Then install `.dev-build/leetion-dev-<version>.xpi` via `about:addons` →
gear icon → *Install Add-on From File…*. The ID stays constant across builds,
so a higher version upgrades the existing install in place.

## What restage.sh changes

The staged copy differs from the working tree in exactly three manifest fields.
The repo's own `manifest.json` is never modified.

| Field | Why |
| --- | --- |
| `browser_specific_settings.gecko.id` | AMO will not sign an ID registered to another account. |
| `name` | Appends `(dev)` so it is distinguishable from the store build in `about:addons`. |
| `version` | AMO rejects a repeat signature, so the fourth part is bumped each run. |

Override the ID with `LEETION_ADDON_ID` if you are not the author. Pass an
explicit version as the first argument (`restage.sh 1.2.0.1`) instead of taking
the automatic bump.

## Output is not committed

`.dev-build/` is gitignored. Signed XPIs and the staged source copy must stay
out of version control — see the repository `LICENSE`, which prohibits
redistributing this software or publishing it to an extension marketplace.
These builds are for personal installation only.

## Notes

- Unlisted add-ons do not auto-update. Each change means re-stage, re-sign,
  re-install.
- Don't run a dev build alongside the store version: both inject into LeetCode
  pages and will race on the same Notion writes.
- Lint warnings (`BACKGROUND_SERVICE_WORKER_IGNORED`, `UNSAFE_VAR_ASSIGNMENT`)
  are non-blocking and also present in the store build. Only `errors` matter.
