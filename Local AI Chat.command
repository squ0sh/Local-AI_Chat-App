#!/bin/bash
# macOS double-clickable launcher: Finder/Spotlight can run .command files.
# (First launch: right-click → Open, then confirm — Gatekeeper treats new
# unsigned scripts cautiously; your own machine keeps control either way.)
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec bash "$DIR/start-portable.sh"
