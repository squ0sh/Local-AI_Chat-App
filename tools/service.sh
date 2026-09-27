#!/usr/bin/env bash
# Run the Capsule as a per-user background service — portable kit first:
# the service launches the same start-portable.sh you double-click, so the
# stick and the permanent install stay one artifact with one data dir.
#
#   bash tools/service.sh install [--allow-open]
#   bash tools/service.sh status | logs | uninstall
#
# Linux  → systemd *user* service (~/.config/systemd/user)
# macOS  → launchd LaunchAgent plist (~/Library/LaunchAgents)
# Windows → see tools/service.cmd (Task Scheduler)
#
# Auth at install time: AUTH_TOKEN (bearer) and data/users.json (multi-user)
# are both honored; with neither the installer explains the risk and needs
# --allow-open to proceed. Nothing here is written system-wide.
set -euo pipefail

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
NAME="local-ai-capsule"
LABEL="com.localai.capsule"
PORT="${PORT:-5173}"
HOST="${HOST:-127.0.0.1}"
AUTH="${AUTH_TOKEN:-}"
USERS_FILE="${CAPSULE_USERS_FILE:-$APP_DIR/.portable/data/users.json}"
LOCALE_PLATFORM="$(uname -s)"
PLATFORM="${LOCAL_AI_SERVICE_PLATFORM:-$LOCALE_PLATFORM}"
DRY_RUN=0
ALLOW_OPEN=0
ACTION="help"

for arg in "$@"; do
  case "$arg" in
    install) ACTION="install" ;;
    uninstall) ACTION="uninstall" ;;
    status) ACTION="status" ;;
    logs) ACTION="logs" ;;
    --dry-run) DRY_RUN=1 ;;
    --allow-open) ALLOW_OPEN=1 ;;
    help|--help|-h) ACTION="help" ;;
    *) echo "service.sh: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

usage() {
  cat <<EOF
Local AI service manager (per-user)

  bash tools/service.sh install [--allow-open]
  bash tools/service.sh status
  bash tools/service.sh logs
  bash tools/service.sh uninstall

Options
  --dry-run     write the service files but do not call systemd/launchd
  --allow-open  install without AUTH_TOKEN and without user accounts (open
                single-operator service on loopback)

Environment respected at install time: PORT, HOST, AUTH_TOKEN, CAPSULE_USERS_FILE.
CAPSULE_SERVICE_SKIP_INTEGRITY=1 skips the signed-manifest preflight (used by the test suite).
EOF
}

note()  { echo "service: $*"; }
fail()  { echo "service: error: $*" >&2; exit 1; }

node_bin() {
  if command -v node >/dev/null 2>&1; then echo "node"; return; fi
  local t=""
  case "${LOCALE_PLATFORM}:$(uname -m)" in
    Linux:x86_64)          t="linux-x64" ;;
    Linux:aarch64|Linux:arm64) t="linux-arm64" ;;
    Darwin:x86_64)         t="darwin-x64" ;;
    Darwin:arm64)          t="darwin-arm64" ;;
  esac
  local candidate="$APP_DIR/runtime/platforms/$t/node/bin/node"
  [[ -x "$candidate" ]] && echo "$candidate" || echo ""
}

pipe_through_integrity_check() {
  if [[ "${CAPSULE_SERVICE_SKIP_INTEGRITY:-}" == "1" ]]; then
    return 0
  fi
  local node; node="$(node_bin)"
  if [[ -z "$node" ]]; then
    note "no Node binary found; skipped the integrity check (run npm run integrity:check when Node is on PATH)"
    return 0
  fi
  if ! (cd "$APP_DIR" && "$node" tools/generate-integrity.mjs --check >/dev/null 2>&1); then
    fail "release files drifted from their signatures. Open the app for restore guidance, or run: npm run integrity"
  fi
  note "release files verify against the signed manifest"
}

auth_gate() {
  if [[ -f "$USERS_FILE" ]]; then
    note "multi-user accounts found ($USERS_FILE) — the service will require sign-in"
  elif [[ -n "$AUTH" ]]; then
    note "single-operator bearer token will be written into the service environment"
  else
    if [[ "$ALLOW_OPEN" != "1" ]]; then
      cat >&2 <<EOF
service: refusing to install an open service.

  No AUTH_TOKEN and no user accounts. Anyone who can reach http://$HOST:$PORT
  gets the full agent surface. Pick one and retry:

    AUTH_TOKEN="a-long-random-secret" bash tools/service.sh install
    node   "$APP_DIR/lib/user-store.mjs" create alice "a long memorable password"

  Or, if you are certain loopback-only exposure is enough, accept the risk:

    bash tools/service.sh install --allow-open
EOF
      exit 1
    fi
    note "installing an open loopback service (--allow-open)"
  fi
}

health_probe() {
  local url="http://127.0.0.1:$PORT/health"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "$url" >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -T 2 -O /dev/null "$url" >/dev/null 2>&1 && return 0
    return 1
  fi
  return 2 # unknown
}

# ── Linux: systemd --user service ───────────────────────────────────────────
systemd_dir() { echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; }

linux_install() {
  local dir; dir="$(systemd_dir)"
  local unit="$dir/$NAME.service"
  command -v systemctl >/dev/null 2>&1 || DRY_RUN=1 && true
  if ! command -v systemctl >/dev/null 2>&1 && [[ "$DRY_RUN" != "1" ]]; then
    fail "systemctl not found — this tool needs systemd. On this kind of Linux, run ./start-portable.sh instead."
  fi
  pipe_through_integrity_check
  auth_gate
  mkdir -p "$dir"
  {
    echo "[Unit]"
    echo "Description=Local AI Chat (Capsule) — per-user managed service"
    echo "After=network-online.target"
    echo
    echo "[Service]"
    echo "Type=simple"
    echo "WorkingDirectory=$APP_DIR"
    echo "Environment=LOCAL_AI_NO_BROWSER=1"
    echo "Environment=PORT=$PORT"
    echo "Environment=HOST=$HOST"
    [[ -n "$AUTH" ]] && echo "Environment=AUTH_TOKEN=$AUTH"
    echo "ExecStart=/usr/bin/env bash $APP_DIR/start-portable.sh"
    echo "Restart=on-failure"
    echo "RestartSec=3"
    echo "TimeoutStopSec=15"
    echo "NoNewPrivileges=true"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } > "$unit"
  note "wrote $unit"
  if [[ "$DRY_RUN" != "1" ]]; then
    systemctl --user daemon-reload
    systemctl --user enable --now "$NAME"
  fi
  note "enabled: systemctl --user enable --now $NAME"
  note "logs:              journalctl --user -u $NAME -f"
  note "survive sign-out:  loginctl enable-linger $USER"
  note "uninstall:         bash $APP_DIR/tools/service.sh uninstall"
}

linux_status() {
  local dir; dir="$(systemd_dir)"
  local unit="$dir/$NAME.service"
  [[ -f "$unit" ]] || fail "no service installed ($unit missing)"
  if [[ "$DRY_RUN" == "1" ]]; then
    note "dry-run: unit file present at $unit"
  else
    systemctl --user status "$NAME" --no-pager || true
  fi
  if health_probe; then
    note "reachable at http://127.0.0.1:$PORT"
  else
    note "not answering http://127.0.0.1:$PORT/health yet (starting? crashed?)"
  fi
}

linux_uninstall() {
  local dir; dir="$(systemd_dir)"
  local unit="$dir/$NAME.service"
  [[ -f "$unit" ]] || fail "no service installed ($unit missing)"
  if [[ "$DRY_RUN" != "1" ]]; then
    systemctl --user disable --now "$NAME" >/dev/null 2>&1 || true
    systemctl --user daemon-reload || true
  fi
  rm -f "$unit"
  note "removed $unit"
  note "data and models were left alone in $APP_DIR/.portable"
}

linux_logs() {
  [[ "$DRY_RUN" == "1" ]] && fail "no logs in --dry-run mode"
  exec journalctl --user -u "$NAME" --no-pager -n 100 "$@"
}

# ── macOS: launchd LaunchAgent ──────────────────────────────────────────────
launch_dir() { echo "${LOCAL_AI_AGENT_DIR:-$HOME/Library/LaunchAgents}"; }

macos_plist_body() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$APP_DIR/start-portable.sh</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LOCAL_AI_NO_BROWSER</key><string>1</string>
    <key>PORT</key><string>$PORT</string>
    <key>HOST</key><string>$HOST</string>$AUTH_XML
  </dict>
  <key>StandardOutPath</key><string>$APP_DIR/.portable/logs/service.out.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/.portable/logs/service.err.log</string>
</dict>
</plist>
EOF
}

macos_install() {
  local dir; dir="$(launch_dir)"
  local plist="$dir/$LABEL.plist"
  pipe_through_integrity_check
  auth_gate
  mkdir -p "$dir" "$APP_DIR/.portable/logs"
  AUTH_XML=""
  [[ -n "$AUTH" ]] && AUTH_XML="
    <key>AUTH_TOKEN</key><string>$AUTH</string>"
  macos_plist_body > "$plist"
  note "wrote $plist"
  if [[ "$DRY_RUN" != "1" ]] && command -v launchctl >/dev/null 2>&1; then
    launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || true
    launchctl kickstart -k "gui/$(id -u)/$LABEL" || true
    note "started via launchd"
  else
    note "load it with: launchctl bootstrap gui/$(id -u) $plist"
  fi
  note "logs:      tail -f $APP_DIR/.portable/logs/service.*.log"
  note "unload:    bash $APP_DIR/tools/service.sh uninstall"
}

macos_status() {
  local plist; plist="$(launch_dir)/$LABEL.plist"
  [[ -f "$plist" ]] || fail "no service installed ($plist missing)"
  if [[ "$DRY_RUN" != "1" ]] && command -v launchctl >/dev/null 2>&1; then
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | sed -n '1,14p' || note "plist installed; agent not loaded yet"
  fi
  if health_probe; then note "reachable at http://127.0.0.1:$PORT"; else note "not answering http://127.0.0.1:$PORT/health yet"; fi
}

macos_uninstall() {
  local plist; plist="$(launch_dir)/$LABEL.plist"
  [[ -f "$plist" ]] || fail "no service installed ($plist missing)"
  [[ "$DRY_RUN" != "1" ]] && command -v launchctl >/dev/null 2>&1 && launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  rm -f "$plist"
  note "removed $plist"
  note "data and models were left alone in $APP_DIR/.portable"
}

macos_logs() {
  exec tail -n 100 "$APP_DIR/.portable/logs/service.err.log" "$APP_DIR/.portable/logs/service.out.log"
}

# ── dispatch ────────────────────────────────────────────────────────────────
[[ "$ACTION" == "help" ]] && { usage; exit 0; }
[[ -f "$APP_DIR/start-portable.sh" ]] || fail "start-portable.sh not found beside this tool — run from the Capsule folder"

case "$PLATFORM" in
  Linux|linux)
    case "$ACTION" in
      install) linux_install ;;
      status) linux_status ;;
      logs) linux_logs "$@" ;;
      uninstall) linux_uninstall ;;
    esac ;;
  Darwin|darwin)
    case "$ACTION" in
      install) macos_install ;;
      status) macos_status ;;
      logs) macos_logs ;;
      uninstall) macos_uninstall ;;
    esac ;;
  *)
    echo "service: unknown platform '$PLATFORM'. On Windows use tools/service.cmd." >&2
    exit 1
    ;;
esac
