#!/bin/bash
# macOS double-clickable launcher: Finder/Spotlight can run .command files.
# Not Apple-notarized: downloaded copies may be blocked by Gatekeeper.
# See START HERE - Mac.txt; never disable OS protections to launch Capsule.
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec bash "$DIR/start-portable.sh"
