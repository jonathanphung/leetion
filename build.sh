#!/bin/bash
# Package the extension into leetion.zip for store upload.
# Prefers Info-ZIP's `zip` (macOS/Linux); falls back to 7-Zip on Windows,
# where Git Bash ships no zip binary.
set -euo pipefail

OUT="leetion.zip"
rm -f "$OUT"

# Excluded from the artifact: VCS state, docs, super-board/Claude tooling,
# this script, prior zips, and scratch dirs.
if command -v zip >/dev/null 2>&1; then
  zip -r "$OUT" . \
    -x "*.git*" -x ".DS_Store" -x "content/*" -x "README.md" -x "LICENSE" \
    -x "build.sh" -x "*.zip" \
    -x ".claude/*" -x ".github/*" -x "docs/*" -x ".worktrees/*"
else
  SEVENZ=""
  for c in 7z "/c/Program Files/7-Zip/7z.exe" "/c/Program Files (x86)/7-Zip/7z.exe"; do
    if command -v "$c" >/dev/null 2>&1; then SEVENZ="$c"; break; fi
  done
  if [ -z "$SEVENZ" ]; then
    echo "build.sh: packaging needs Info-ZIP 'zip' or 7-Zip; neither found." >&2
    echo "  Windows: winget install 7zip.7zip" >&2
    exit 69
  fi
  "$SEVENZ" a -tzip "$OUT" '*' \
    '-xr!.git' '-xr!.gitignore' '-xr!.DS_Store' '-xr!*.zip' \
    '-x!content' '-x!README.md' '-x!LICENSE' '-x!build.sh' \
    '-x!.claude' '-x!.github' '-x!docs' '-x!.worktrees' >/dev/null
fi

echo "Done! Created $OUT"
