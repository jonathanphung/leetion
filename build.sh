#!/bin/bash
# zip updates an existing archive rather than replacing it, so a stale copy of a
# deleted or renamed file would linger in every future build. Start clean.
rm -f leetion.zip
zip -r leetion.zip . -x "*.git*" -x ".DS_Store" -x "content/*" -x "README.md" -x "LICENSE" -x "CONTRIBUTING.md" -x ".gitignore" -x "build.sh" -x "*.zip"
echo "Done! Created leetion.zip"
