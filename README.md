# Local AI Chat

A local AI chat app **and** OpenAI-compatible API server for your Ollama
models. Exposed locally, or publicly through a Cloudflare quick tunnel.

- Zero dependencies — runs on Node's built-ins (Node 18+).
- Clean single-file web chat UI.
- Thin passthrough proxy to Ollama's own `/v1` OpenAI-compatible endpoints,
  so any OpenAI client (OpenClaude, chat SDKs, etc.) can point at local models.

## Quick start

```bash
# Local only (default)
npm start

# Start with a Cloudflare quick tunnel (public URL)
npm run tunnel

# Change port / Ollama location
npm start -- --port 8080 --ollama-url http://127.0.0.1:11434
```

Open the chat UI at <http://localhost:5173>. The server binds to `127.0.0.1`
by default; use `--host 0.0.0.0` only when you intentionally want LAN access.

## OpenAI-compatible endpoint

| Endpoint              | Purpose                        |
| --------------------- | ------------------------------ |
| `GET  /v1/models`     | List models                    |
| `POST /v1/chat/completions` | Chat (streaming + non-streaming) |
| `GET  /health`        | Server + Ollama status         |
| `GET  /api/models`    | Native Ollama tag list         |

Point any OpenAI client at base URL `http://localhost:5173/v1`.

## Model CLI

Manage models without the UI:

```bash
npm run models                      # list installed models
node tools/model-cli.mjs list --json
node tools/model-cli.mjs pull llama3.2:3b
node tools/model-cli.mjs search qwen
node tools/model-cli.mjs info llama3.2:3b
```

## Configuration (environment variables)

| Variable              | Default                  | Description                          |
| --------------------- | ------------------------ | ------------------------------------ |
| `OLLAMA_URL`          | `http://127.0.0.1:11434`| Ollama API base URL                  |
| `PORT`                | `5173`                 | Local AI Chat listening port         |
| `HOST`                | `127.0.0.1`            | Bind address; use `0.0.0.0` for LAN access |
| `OLLAMA_API_KEY`      | *(unset)*                | Upstream auth bearer (if Ollama gated) |
| `AUTH_TOKEN`          | *(unset)*                | Require `Authorization: Bearer` on this server |
| `CLOUDFLARED_PATH`    | *(auto-detect)*          | Path to cloudflared binary           |

## Tunnel mode

`npm run tunnel` starts the server with `--mode tunnel`. If `cloudflared` is
not found on `PATH` (or in `data/bin/`), it is automatically downloaded from
GitHub Releases. The public trycloudflare URL is printed to the console.

> Note: quick tunnels are ephemeral — the URL changes each run. Do not use
> them for long-lived public exposure without additional security (set
> `AUTH_TOKEN`).
