#!/usr/bin/env bash
# Self-contained Local AI Chat launcher for Linux and macOS.
set -euo pipefail

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PORTABLE_DIR="$APP_DIR/.portable"
APP_PORT="${LOCAL_AI_PORT:-5173}"
KERNEL="$(uname -s)"
MACHINE="$(uname -m)"
case "$KERNEL:$MACHINE" in
  Linux:x86_64) TARGET="linux-x64" ;;
  Linux:aarch64|Linux:arm64) TARGET="linux-arm64" ;;
  Darwin:x86_64) TARGET="darwin-x64" ;;
  Darwin:arm64) TARGET="darwin-arm64" ;;
  *) echo "No bundled runtime supports $KERNEL $MACHINE." >&2; exit 1 ;;
esac

RUNTIME_DIR="$APP_DIR/runtime/platforms/$TARGET"
CACHE_DIR="$PORTABLE_DIR/cache"
mkdir -p "$CACHE_DIR"

if [[ -f "$APP_DIR/runtime/downloads.txt" ]]; then

  NODE_BIN="$RUNTIME_DIR/node/bin/node"
  OLLAMA_BIN="$RUNTIME_DIR/ollama/ollama"
  OLLAMA_LIB_DIR="$RUNTIME_DIR/ollama/lib/ollama"

  shasum_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    else echo ""; fi
  }

  binary_ok() {
    local bin="$1" min="${2:-0}"
    [[ -x "$bin" ]] && [[ "$(stat -c %s "$bin" 2>/dev/null || stat -f %z "$bin" 2>/dev/null || echo 0)" -ge "$min" ]]
  }

  runtime_row() {
    awk -F '\t' -v t="$TARGET" -v k="$1" '$1==t && $2==k { print; exit }' "$APP_DIR/runtime/downloads.txt"
  }

  download_runtime() {
    local kind="$1" bin="$2" dir="$3"
    local row url archive got sha_arc sha_bin fname
    row="$(runtime_row "$kind")"
    if [[ -z "$row" ]]; then
      echo "No download entry for $TARGET $kind." >&2
      echo "Manual restore: node ./tools/package-runtimes.mjs --platform-id $TARGET" >&2
      exit 1
    fi
    url="$(cut -f3 <<<"$row")"
    sha_arc="$(cut -f4 <<<"$row")"
    sha_bin="$(cut -f5 <<<"$row")"
    fname="$(basename -- "$url")"
    archive="$CACHE_DIR/$fname"
    if [[ ! -e "$archive" ]]; then
      if [[ -z "${LOCAL_AI_AUTO_DOWNLOADS:-}" ]]; then
        echo "The bundled $kind runtime for $TARGET is missing or unusable." >&2
        read -r -p "Download $kind now? [Y/n] " -n 1 ans || true
        echo >&2
        [[ "$ans" =~ ^[Yy]?$ ]] || { echo "Download skipped. See README for manual setup." >&2; exit 1; }
      fi
      echo "  Downloading $url …" >&2
      if command -v curl >/dev/null 2>&1; then curl -fL --retry 2 -o "$archive.tmp" "$url"
      elif command -v wget >/dev/null 2>&1; then wget -qO "$archive.tmp" "$url"
      else echo "Neither curl nor wget is available; cannot restore $kind." >&2
           echo "Manual restore: node ./tools/package-runtimes.mjs --platform-id $TARGET" >&2
           exit 1
      fi
      mv "$archive.tmp" "$archive"
    fi
    if [[ -n "$sha_arc" && "$sha_arc" != "-" ]]; then
      got="$(shasum_of "$archive")"
      if [[ "$got" != "$sha_arc" ]]; then
        echo "Downloaded archive hash does not match the release pin ($fname)." >&2
        echo "Manual restore: node ./tools/package-runtimes.mjs --platform-id $TARGET" >&2
        exit 1
      fi
    fi
    mkdir -p "$dir"
    case "$archive" in
      *.tar.xz)  tar -C "$dir" --strip-components=1 -xJf "$archive" ;;
      *.tgz)     tar -C "$dir" -xzf "$archive" ;;
      *.tar.zst) if command -v unzstd >/dev/null 2>&1; then tar -C "$dir" --use-compress-program=unzstd -xf "$archive"
                 else tar -C "$dir" --zstd -xf "$archive"; fi ;;
      *) echo "Unsupported archive format for $kind: $fname" >&2
         echo "Manual restore: node ./tools/package-runtimes.mjs --platform-id $TARGET" >&2
         exit 1 ;;
    esac
    chmod +x "$bin" 2>/dev/null || true
    if [[ -n "$sha_bin" && "$sha_bin" != "-" && "${LOCAL_AI_VERIFY_RUNTIMES:-}" == "1" ]]; then
      got="$(shasum_of "$bin")"
      if [[ "$got" != "$sha_bin" ]]; then
        echo "Restored $kind binary does not match its release pin." >&2
        echo "Manual restore: node ./tools/package-runtimes.mjs --platform-id $TARGET" >&2
        exit 1
      fi
    fi
    echo "  Restored $kind ($TARGET)." >&2
  }

  [[ " $* " == *" --verify-runtimes "* ]] && export LOCAL_AI_VERIFY_RUNTIMES="1"

  if ! binary_ok "$NODE_BIN" 5242880; then
    download_runtime node "$NODE_BIN" "$RUNTIME_DIR/node"
  fi
  if ! binary_ok "$OLLAMA_BIN" 5242880; then
    download_runtime ollama "$OLLAMA_BIN" "$RUNTIME_DIR/ollama"
  fi
  if [[ ! -x "$OLLAMA_BIN" ]]; then
    for candidate in "$RUNTIME_DIR/ollama/bin/ollama" "$RUNTIME_DIR/ollama/ollama"; do
      if [[ -x "$candidate" ]]; then OLLAMA_BIN="$candidate"; break; fi
    done
  fi
  if [[ ! -d "$OLLAMA_LIB_DIR" ]]; then
    for candidate in "$RUNTIME_DIR/ollama/lib/ollama" "$RUNTIME_DIR/ollama/lib"; do
      if [[ -d "$candidate" ]]; then OLLAMA_LIB_DIR="$candidate"; break; fi
    done
  fi

  if [[ ! -x "$NODE_BIN" ]]; then
    echo "The bundled Node runtime is still missing or not executable: $NODE_BIN" >&2
    echo "Manual restore: node ./tools/package-runtimes.mjs --platform-id $TARGET" >&2
    exit 1
  fi
  if [[ ! -x "$OLLAMA_BIN" ]]; then
    echo "The bundled Ollama runtime is still missing or not executable: $OLLAMA_BIN" >&2
    echo "Manual restore: node ./tools/package-runtimes.mjs --platform-id $TARGET" >&2
    exit 1
  fi
  if [[ "${LOCAL_AI_VERIFY_RUNTIMES:-}" == "1" ]]; then
    echo "Verifying bundled runtimes against release pins…" >&2
    "$NODE_BIN" --version >/dev/null 2>&1 || { echo "Bundled Node failed its smoke check." >&2; exit 1; }
    "$OLLAMA_BIN" --version >/dev/null 2>&1 || { echo "Bundled Ollama failed its smoke check." >&2; exit 1; }
  fi

else
  NODE_BIN="$RUNTIME_DIR/node/bin/node"
  OLLAMA_BIN="$RUNTIME_DIR/ollama/ollama"
  OLLAMA_LIB_DIR="$RUNTIME_DIR/ollama/lib/ollama"
  if [[ ! -x "$NODE_BIN" ]]; then
    echo "The bundled Node runtime is missing or not executable: $NODE_BIN" >&2
    exit 1
  fi
  if [[ ! -x "$OLLAMA_BIN" ]]; then
    echo "The bundled Ollama runtime is missing or not executable: $OLLAMA_BIN" >&2
    exit 1
  fi
fi

mkdir -p "$PORTABLE_DIR/data" "$PORTABLE_DIR/ollama/models" "$PORTABLE_DIR/logs"
export LOCAL_AI_DATA_DIR="$PORTABLE_DIR/data"
export LOCAL_AI_NODE_BIN="$NODE_BIN"
export LOCAL_AI_OLLAMA_BIN="$OLLAMA_BIN"

APP_URL="http://127.0.0.1:$APP_PORT"

app_alive() {
  "$NODE_BIN" -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$APP_URL/health" >/dev/null 2>&1
}

open_browser() {
  [[ -z "${LOCAL_AI_NO_BROWSER:-}" ]] || return 0
  if [[ "$KERNEL" == "Darwin" ]]; then
    ( command -v open >/dev/null 2>&1 && open "$APP_URL" >/dev/null 2>&1 ) &
  else
    ( command -v xdg-open >/dev/null 2>&1 && xdg-open "$APP_URL" >/dev/null 2>&1 ) &
  fi
}

# Second-launch convenience: if this port already serves the app, surface it
# in the browser instead of dying on an address-in-use error.
if app_alive; then
  if [[ -n "${LOCAL_AI_NO_BROWSER:-}" ]]; then
    echo "Local AI Chat is already running at $APP_URL"
  else
    echo "Local AI Chat is already running at $APP_URL — opening your browser."
    open_browser
  fi
  exit 0
fi
export OLLAMA_MODELS="$PORTABLE_DIR/ollama/models"
if [[ "$KERNEL" == "Darwin" ]]; then
  export DYLD_LIBRARY_PATH="$OLLAMA_LIB_DIR${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
else
  export LD_LIBRARY_PATH="$OLLAMA_LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
# Keep the portable runtime isolated from any Ollama installation already on
# the host. This prevents its models from being silently replaced by the host's
# model library.
export OLLAMA_HOST="127.0.0.1:11435"
# Preserve resumable Hugging Face layers and their manifests across portable
# restarts. Automatic pruning can mistake a recently finalized direct-HF model
# for an unused cache entry on some Ollama builds.
export OLLAMA_NOPRUNE="true"
# Machines without the Capsule signing key accept the unsigned manifest that
# `npm run integrity` generates. Maintainers with the key keep signed checks.
if [[ ! -f "$HOME/.capsule-signing/key.pem" ]]; then
  export CAPSULE_ALLOW_UNSIGNED="1"
  echo "Capsule integrity: unsigned mode (no signing key). After code changes run: npm run integrity"
fi

OLLAMA_PID=""
ollama_ready() {
  OLLAMA_URL="http://127.0.0.1:11435" "$NODE_BIN" "$APP_DIR/tools/ollama-health.mjs" >/dev/null 2>&1
}

if ! ollama_ready; then
  "$OLLAMA_BIN" serve >"$PORTABLE_DIR/logs/ollama.log" 2>&1 &
  OLLAMA_PID=$!
  echo "Starting portable Ollama…"
  for _ in {1..120}; do
    ollama_ready && break
    if ! kill -0 "$OLLAMA_PID" 2>/dev/null; then
      echo "Portable Ollama stopped during startup. See .portable/logs/ollama.log." >&2
      exit 1
    fi
    sleep 0.25
  done
  if ! ollama_ready; then
    echo "Portable Ollama did not become ready. See .portable/logs/ollama.log." >&2
    exit 1
  fi
fi

cleanup() { [[ -n "$OLLAMA_PID" ]] && kill "$OLLAMA_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Bring the user straight to the app: a background waiter watches /health and
# opens the default browser as soon as the server answers. (LOCAL_AI_NO_BROWSER=1
# turns this off — servers and SSH sessions.)
if [[ -z "${LOCAL_AI_NO_BROWSER:-}" ]]; then
  (
    for _ in $(seq 1 120); do
      if app_alive; then
        echo "Ready — opening your browser at $APP_URL"
        open_browser
        break
      fi
      sleep 0.5
    done
  ) &
fi

echo "Starting Local AI Chat at http://127.0.0.1:$APP_PORT"
echo "(set LOCAL_AI_NO_BROWSER=1 to skip the automatic browser window)"
if [[ "$KERNEL" == "Linux" ]]; then
  _DESKTOP_ENTRY="${XDG_DATA_HOME:-$HOME/.local/share}/applications/local-ai-capsule.desktop"
  if [[ ! -f "$_DESKTOP_ENTRY" && -f "$APP_DIR/tools/register-menu-entry.sh" ]]; then
    echo "Tip: add an app-menu icon with: bash tools/register-menu-entry.sh"
  fi
fi
OLLAMA_URL="http://127.0.0.1:11435" "$NODE_BIN" "$APP_DIR/server.mjs" --mode local --host 127.0.0.1 --port "$APP_PORT"
