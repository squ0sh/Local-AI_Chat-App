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

mkdir -p "$PORTABLE_DIR/data" "$PORTABLE_DIR/ollama/models" "$PORTABLE_DIR/logs"
export LOCAL_AI_DATA_DIR="$PORTABLE_DIR/data"
export LOCAL_AI_NODE_BIN="$NODE_BIN"
export LOCAL_AI_OLLAMA_BIN="$OLLAMA_BIN"
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

echo "Starting Local AI Chat at http://127.0.0.1:$APP_PORT"
OLLAMA_URL="http://127.0.0.1:11435" "$NODE_BIN" "$APP_DIR/server.mjs" --mode local --host 127.0.0.1 --port "$APP_PORT"
