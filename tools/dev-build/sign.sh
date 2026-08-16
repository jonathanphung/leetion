#!/bin/bash
# Sign the staged dev build as an unlisted AMO add-on and park the XPI.
#
# Credentials are prompted for, never stored or passed on the command line of
# an interactive shell, so they stay out of shell history.
# Get them at: https://addons.mozilla.org/en-US/developers/addon/api/key/
set -euo pipefail

REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
STAGE="$REPO/.dev-build"
SRC="$STAGE/src"

[ -d "$SRC" ] || { echo "No staged build — run tools/dev-build/restage.sh first." >&2; exit 1; }

VERSION="$(node -p "require('$SRC/manifest.json').version")"
echo "Signing version $VERSION"

read -r  -p "AMO JWT issuer (key, starts with 'user:'): " AMO_KEY
read -rs -p "AMO JWT secret (hidden): " AMO_SECRET; echo

cd "$SRC"
npx --yes web-ext@latest sign \
  --channel=unlisted \
  --api-key="$AMO_KEY" \
  --api-secret="$AMO_SECRET"

cp "$(ls -t "$SRC/web-ext-artifacts/"*.xpi | head -1)" "$STAGE/leetion-dev-$VERSION.xpi"

echo
echo "Signed: .dev-build/leetion-dev-$VERSION.xpi"
echo "Install in Zen: about:addons -> gear icon -> Install Add-on From File..."
