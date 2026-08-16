#!/bin/bash
# Stage the working tree into .dev-build/src as an unlisted dev build.
#
# Copies the repo (minus repo-only files), then rewrites three manifest fields:
#   - id      -> an add-on ID you own, so AMO will sign it
#   - name    -> marked "(dev)" so it is distinguishable from the store version
#   - version -> bumped, since AMO refuses to sign the same version twice
#
# Usage: tools/dev-build/restage.sh [version]
#   No argument bumps the fourth version part (1.1.5 -> 1.1.5.1 -> 1.1.5.2).
#   Override the add-on ID with LEETION_ADDON_ID if you are not the author.
set -euo pipefail

REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
STAGE="$REPO/.dev-build"
SRC="$STAGE/src"
ADDON_ID="${LEETION_ADDON_ID:-leetion-dev@jonathanphung.com}"

# Mirrors build.sh's exclusions, plus dev-build's own output.
rm -rf "$SRC" && mkdir -p "$SRC"
rsync -a \
  --exclude '.git' --exclude '.git*' --exclude '.DS_Store' --exclude 'content/' \
  --exclude 'README.md' --exclude 'LICENSE' --exclude 'build.sh' \
  --exclude '*.zip' --exclude '*.xpi' --exclude 'web-ext-artifacts/' \
  --exclude '.claude/' --exclude '.github/' --exclude 'docs/' \
  --exclude '.worktrees/' --exclude 'node_modules/' \
  --exclude '.dev-build/' --exclude 'tools/' \
  "$REPO/" "$SRC/"

node -e '
const fs = require("fs"), [path, want, id] = process.argv.slice(1);
const m = JSON.parse(fs.readFileSync(path, "utf8"));
const parts = m.version.split(".");
m.version = want || parts.slice(0, 3).join(".") + "." + (Number(parts[3] || 0) + 1);
m.name = "Leetion (dev) - LeetCode to Notion";
m.browser_specific_settings.gecko.id = id;
fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
console.log("staged " + m.name + " " + m.version + " (" + id + ")");
' "$SRC/manifest.json" "${1:-}" "$ADDON_ID"

# A prior signature for this version would make the sign step fail late.
VERSION="$(node -p "require('$SRC/manifest.json').version")"
if [ -e "$STAGE/leetion-dev-$VERSION.xpi" ]; then
  echo "warning: $STAGE/leetion-dev-$VERSION.xpi already exists;" >&2
  echo "         AMO will reject a repeat signature for $VERSION. Pass a higher version." >&2
fi

echo "Linting..."
cd "$SRC" && npx --yes web-ext@latest lint --self-hosted 2>&1 |
  grep -E "^(Validation|errors|warnings|notices)" | head -5 || true
echo "Next: tools/dev-build/sign.sh"
