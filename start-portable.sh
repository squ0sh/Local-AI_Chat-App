#!/usr/bin/env bash
# Portable Local AI Chat launcher for Linux and macOS.
# Optional bundled runtimes live in runtime/node and runtime/ollama.
set -euo pipefail

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PORTABLE_DIR="$APP_DIR/.portable"
NODE_BIN="$APP_DIR/runtime/node/bin/node"
OLLAMA_BIN="$APP_DIR/runtime/ollama/ollama"

if [[ ! -x "$NODE_BIN" ]]; then NODE_BIN="$(command -v node || true)"; fi
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 18+ was not found. Bundle it in runtime/node or install Node.js." >&2
  exit 1
fi

if [[ ! -x "$OLLAMA_BIN" ]]; then OLLAMA_BIN="$(command -v ollama || true)"; fi
if [[ -z "$OLLAMA_BIN" ]]; then
  echo "Ollama was not found. Bundle it in runtime/ollama or install Ollama." >&2
  exit 1
fi

mkdir -p "$PORTABLE_DIR/ollama/models" "$PORTABLE_DIR/logs"
export LOCAL_AI_DATA_DIR="$PORTABLE_DIR/data"
export OLLAMA_MODELS="$PORTABLE_DIR/ollama/models"
export OLLAMA_HOST="127.0.0.1:11434"

OLLAMA_PID=""
if ! curl --silent --fail http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  "$OLLAMA_BIN" serve >"$PORTABLE_DIR/logs/ollama.log" 2>&1 &
  OLLAMA_PID=$!
  echo "Starting portable Ollama…"
fi

cleanup() { [[ -n "$OLLAMA_PID" ]] && kill "$OLLAMA_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "Starting Local AI Chat at http://127.0.0.1:5173"
"$NODE_BIN" "$APP_DIR/server.mjs" --mode local --host 127.0.0.1 --port 5173
