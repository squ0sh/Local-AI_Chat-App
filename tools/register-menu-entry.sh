#!/usr/bin/env bash
# Register (or remove) a Linux desktop-menu entry for the Capsule.
# Writes only into the standard user applications dir — nothing system-wide.
#
#   bash tools/register-menu-entry.sh            # install
#   bash tools/register-menu-entry.sh --remove   # uninstall
#
set -euo pipefail

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ENTRY="$APPS_DIR/local-ai-capsule.desktop"

if [[ "${1:-}" == "--remove" ]]; then
  if [[ -f "$ENTRY" ]]; then
    rm -f "$ENTRY"
    echo "Removed $ENTRY"
  else
    echo "No menu entry found at $ENTRY"
  fi
  exit 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This tool is for Linux. On macOS double-click \"Local AI Chat.command\" instead." >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/start-portable.sh" ]]; then
  echo "start-portable.sh not found beside this tool — run it from the Capsule folder." >&2
  exit 1
fi

mkdir -p "$APPS_DIR"
# Exec arguments pass through desktop-string and command-line unescaping.
case "$APP_DIR" in
  *$'\n'*|*$'\r'*) echo "A folder name containing a newline is unsupported." >&2; exit 1 ;;
esac
escape_exec() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  value="${value//\`/\\\`}"
  value="${value//\\/\\\\}"
  value="${value//%/%%}"
  printf '%s' "$value"
}
EXEC_PATH="$(escape_exec "$APP_DIR/start-portable.sh")"
ICON_PATH="${APP_DIR//\\/\\\\}/assets/icon.svg"
cat > "$ENTRY" <<EOF
[Desktop Entry]
Type=Application
Name=Local AI Chat
Comment=Private local AI workspace — chat, agent, voice, images
Keywords=AI;chat;local;capsule;
Exec=bash "$EXEC_PATH"
Icon=$ICON_PATH
Terminal=false
Categories=Utility;
StartupNotify=true
EOF

echo "Menu entry installed: $ENTRY"
echo "Local AI Chat should now appear in your app menu (log out/in if it does not show up yet)."
echo "Remove it later with: bash tools/register-menu-entry.sh --remove"
