# Local AI Chat

A local AI chat app **and** OpenAI-compatible API server for your Ollama
models. Exposed locally, or publicly through a Cloudflare quick tunnel.

## Sharing modes

### Portable USB kit

The Capsule is self-contained for Windows, Linux, and macOS on x64 and ARM64.
Use `start-portable.sh` on Linux/macOS or double-click `start-portable.cmd` on
Windows. The launcher selects a matching bundled Node and Ollama runtime; it
never silently falls back to host-installed software.

Models, settings, logs, and tunnel tooling stay under `.portable/`, so the app
does not touch the host's Ollama library or require a system Node installation.

The kit includes these pieces beside the launchers:

```
runtime/platforms/       # six platform-specific Node and Ollama runtimes
.portable/ollama/models/ # preloaded Ollama model library
```

The model files are usually much larger than the app itself. Use a small
quantized 3B–4B model for a friend-friendly package; it will start and respond
far better than a 9B model on typical laptops.

Use exFAT, NTFS, or a Linux filesystem for a flash drive. FAT32 cannot store an
individual file larger than 4 GB, which many AI models exceed. A drive mounted
with `noexec` cannot launch binaries in place; copy the Capsule to a local
folder in that case.

### Capsule integrity

`capsule-integrity.json` pins every release file with a sha256 hash, signed with
an ed25519 key. Every release file also carries a **compressed canonical copy**
inside the manifest itself, so the Capsule can repair itself without the
original file. The launcher and the **Portable readiness** panel verify the
files at startup, so a corrupt, missing, or modified file is caught immediately.

Self-healing is **safe by default**: a tracked file that is *missing* is restored
automatically from its embedded copy in the manifest. A file that is *present but
different* is never clobbered — the readiness panel lists it and offers **Restore
file** (write the canonical copy back) or **Regenerate manifest** (accept your
change as the new release state). Use **Restore missing files** in the panel to
re-attempt an automatic repair at any time.

Bundled runtimes also self-heal. `runtime/downloads.txt` pins the official
download URL plus archive and binary SHA-256 hashes for Node and Ollama on every
supported platform. When a bundled binary is missing or below its size floor, the
launcher asks once (`LOCAL_AI_AUTO_DOWNLOADS=1` skips the prompt), downloads to
`.portable/cache/`, verifies the archive hash, and extracts it. Pass
`--verify-runtimes` to the launchers for a full binary hash check against the
pins (plus a `--version` smoke check) on every start.

Anyone can work on the Capsule without the release key:

- Change files freely. At the next start the banner tells you which files differ
  and what to do.
- Regenerate the manifest after any tracked change:

  ```
  npm run integrity
  ```

- On a machine without `~/.capsule-signing/key.pem` the regenerated manifest is
  unsigned. `start-portable.sh` (and `start-portable.cmd` on Windows) detects
  the missing key and automatically sets `CAPSULE_ALLOW_UNSIGNED=1`, so the
  readiness check stays green. The same effect applies when you launch with
  `node server.mjs` and set the variable yourself.

Release builds are signed with the private key (`~/.capsule-signing/key.pem`,
never committed). Keep that key on the release machine only; consumers ship and
verify against the pinned public key `capsule-signing-pub.pem`.

A versioned pre-commit hook refills the manifest automatically, so a normal
"edit, commit, push" workflow never leaves the release files and their
fingerprints out of sync. Enable it once per clone:

```
npm run hooks:install
```

On every commit that touches a guarded file the hook runs `npm run integrity`
and stages the refreshed manifest; it refuses a commit where a guarded file has
both staged and unstaged edits, so a refresh never pins half-applied work.
`npm run integrity:check` compares the pinned files against the manifest without
writing anything and is part of `npm run ci` for a readable check.

### Curated local model choices

Open **Model library** in the Capsule sidebar. It shows what is installed,
checks that Ollama's manifest and blob sizes are intact, reports the exact
portable storage path, and runs disk/FAT32 preflight before a pull. Interrupted
Ollama pulls can be started again to resume their partial layers.

The curated catalog is uncensored-first and uses explicit model tags or GGUF
quantizations so a future `latest` alias does not silently change the USB kit:

| Preset | Command | Download | Best for |
| --- | --- | ---: | --- |
| Fast & light | `npm run model:portable` | ~0.8 GB | Abliterated Gemma text chat on low-memory computers |
| Balanced | `npm run model:balanced` | ~2.5 GB | Abliterated general conversation and writing |
| Strong | `npm run model:reasoning` | ~4.9 GB | Uncensored general, coding, math, and agentic work |
| Coding | `npm run model:coding` | ~4.1 GB | Uncensored code writing, explanation, and debugging |
| Vision | `npm run model:vision` | ~8.6 GB | Abliterated screenshots, charts, tables, and diagrams |
| Qwythos 9B | `npm run model:qwythos` | ~7.6 GB | Portable Claude-Mythos-style reasoning and tool use |
| DeepSeek R1 14B | `npm run model:deepseek-r1` | ~9.0 GB | Deeper reasoning on a 16 GB-class computer |
| GPT-OSS 20B Heretic | `npm run model:gpt-oss` | ~12.1 GB | Compact MoE reasoning and agentic work; 16 GB is tight |
| Qwen3.6 35B-A3B Heretic | `npm run model:qwen36-moe` | ~16.9 GB | Premium 3B-active MoE for 24 GB-and-up systems |
| Qwopus3.6 27B Preview | `npm run model:qwopus` | ~16.6 GB | Experimental Opus-style dense reasoning fine-tune |
| Dolphin Mixtral 8x7B | `npm run model:dolphin-mixtral` | ~17.0 GB | Established legacy MoE for 24–32 GB systems |

The category badges in the UI deliberately separate everyday, specialized,
reasoning, advanced, premium, experimental, and legacy choices. This keeps the
catalog ready for multiple alternatives per category without hiding the real
hardware tier or presenting experimental fine-tunes as proven replacements.

Every curated choice is now explicitly uncensored or abliterated. Less alignment
does not mean greater accuracy, safety, or agent reliability. Review every
model's source and license in the library before redistributing it; community
variants are not produced or audited by this project.

The UI is the safest installation path. The commands above target the portable
Ollama server on port 11435, so start the Capsule first and run a command in a
second terminal only if you prefer the CLI:

```bash
npm run model:balanced
```

Installed models stay on disk, but they do not all occupy memory. Ollama loads
a model when it is used and normally releases it after its keep-alive window.
Installed cards show the separate **Selected** and **Loaded in memory** states.
Use **Load into memory** to warm and keep any downloaded model ready without
sending a message. Use **Unload from memory** or **Unload all** to free RAM/VRAM
immediately without deleting the model or changing the chat selection. A
selected but unloaded model still reloads automatically with the next message.

Installed cards also provide **Use**, **Details**, **Verify files**, and
confirmed **Remove** actions. The Import / explore tab can pull any valid
Ollama model name or register GGUF files placed in `models/`. All model
management, including memory controls, remains local-only and is unavailable
to Remote guests.

Agent Mode starts with plain language. Turn on **Use Agent Mode**, and the Start
screen offers a few one-click starters: **Start a task** (describe anything),
**Ask my files** (answers that cite your project), **Text tools** (draft,
summarize, polish, or translate in one card), and **Organize my files** (sort a
folder by year or type — preview the plan, approve, and **Undo** any move
afterwards). Deep Research, Skills, a model-readiness check, and **Our Norms**
stay one click away, and the research panel remains available through
`/research`. A **Changes** card opens the change ledger: every write, folder
organization, image generation, and saved research report is listed with its own
**Undo** button, so anything the agent did on this run can be put back — in any
order, not just the last change.

### Fit — the machine's own settings
A **Fit** card measures this computer once with a small dependency-free
benchmark and normalizes it against the reference build machine (an Intel
Core i5-3570 = 1.0×). One **level** — **Frugal**, **Balanced**, or **Max** —
then picks a coherent bundle of defaults: which curated model to suggest,
how big generated images can be, whether high-res refinement stays on, which
offline voice engine to prefer, and how many CPU threads the image engine
uses. Predictions are self-correcting: every real chat stream and every real
image job is quietly measured (tokens/second, minutes per megapixel) and
blended into the next estimate, so the numbers drift toward this machine's
actual behavior without any configuration. Fit only ever proposes — it never
changes a model you have chosen yourself.

SIMD detection is cross-platform: Linux reads `/proc/cpuinfo`, macOS reads
`sysctl`. On Windows it normally reports a conservative `baseline` tier; to
report real SIMD regardless, build the tiny optional helper with
`tools/build-cpuid.ps1` (C source in `tools/cpuid.c`) and it is picked up
automatically.

Each chat keeps its own agent memory: the conversation the agent saw is saved,
and relaunching a task in the same chat continues from where you left off. A new
chat starts fresh. `/forget` clears that memory.

The **Tools** button beside the message bar opens the optional `/` command menu.
There are few commands on purpose — most things you might type are better
described in plain words and the agent handles them itself. `/help` lists
everything; the ones worth knowing:

- `/status` — model, memory, workspace, and mode at a glance.
- `/run <command>` — run a command after your confirmation.
- `/write [path]` — review and write a file.
- `/undo` — revert the most recent change (files, moves, images, research).
- `/research [topic]` — cited deep research (own Quick and Deep modes).
- `/mcp` — list or call MCP tools (connect a local server via the MCP panel).
- `/new`, `/model`, `/agent`, `/skills`, `/norms`, `/stop`, `/clear`, `/forget`.

Offline behavior packs live inside Agent Mode. Choose **Choose a skill** or use
`/skills`; the selected pack updates the current chat's system prompt. Skills
no longer occupy a separate Capsule sidebar entry.

### Deep Research

Choose **Research a topic** in Agent Mode, or use `/research` (optionally
followed by a question). The local-only research panel offers two bounded modes:

- **Quick** — one search round and up to four readable public sources.
- **Deep** — up to three search rounds and ten sources, with evidence-gap
  checks between rounds.

The selected Ollama model plans searches, extracts evidence, and writes the
report. Web pages are downloaded directly for analysis, so this feature needs
internet access even though the model and report processing remain local.
Progress is visible while it runs, `/stop` cancels it, and completed reports
can be reopened, continued in chat, or exported as Markdown. Reports and their
source ledgers are saved under the active portable data directory at
`data/research/` (normally `.portable/data/research/`).

Research accepts only public HTTP(S) pages, rechecks redirects, blocks local
and private-network destinations, caps page sizes and timeouts, and converts
only collected source IDs into clickable citations. Research controls and
saved reports are unavailable through Capsule Remote.

### Live Voice

Press the microphone icon to open the full Voice Mode screen. It shows the
selected model, live transcript, and clear Listening, Thinking, Speaking, and
Muted states. Use Mute to pause the microphone, tap the animated orb to
interrupt speech, or choose End voice to return to chat. Voice Mode listens for
one utterance, sends the transcript, speaks the complete model response, and
then resumes listening. It uses short recognition sessions for iPhone Safari
compatibility, avoids listening while the answer is playing, chunks long
answers for more reliable speech output, keeps the screen awake when supported,
and prefers a local enhanced/neural OS voice when one is available.

The selected Ollama model remains the conversational model, so the spoken
answer has the same behavior as typed chat. The speech-recognition and speech
layers come from the current browser/operating system for maximum portability;
some platforms may use an online speech service. The microphone indicator is
red while Voice Mode is listening, blue while waiting for the model, and green
while speaking. Capsule Remote can use Voice Mode over its HTTPS private link
when the mobile browser grants microphone access.

### Image Generation

Open **Images** in the Capsule sidebar to generate pictures locally with
[stable-diffusion.cpp](https://github.com/ggml-org/stable-diffusion.cpp). The
first run installs the image engine and the bundled **Realistic Vision v6**
(Q8_0) model (~1.8 GB); images render offline on the CPU and never leave this
computer. The UI is intentionally minimal — type a prompt and pick a size:

| Size button | Output | Typical time on a mid-range CPU |
|-------------|--------|----------------------------------|
| Detailed     | 512 × 512 | ~18 min |
| Balanced     | 384 × 384 | ~8 min  |
| Quick        | 256 × 256 | ~4 min  |

Everything else (steps, sampler, guidance, negative prompt) is tuned
automatically. Each image runs two passes for quality: the sampler pass plus a
high-resolution refinement pass. Generated images appear in the chat area, can
be opened full-size, re-run, or saved, and are written to `data/image/out/`
(normally `.portable/data/image/out/`) with their settings in `meta.json`.

Generation runs as a single internal job per prompt and is stopped if you leave
the app. Requests are queued, and only jobs that complete are presented.

### Share over the web

For a temporary private link, choose a strong token and run:

```bash
AUTH_TOKEN="a-long-random-secret" npm run tunnel
```

The app refuses tunnel mode without that token. Send the URL and token through
separate channels. Quick-tunnel links are temporary; for a stable public site,
run this app on a small VM/container with Ollama, HTTPS, a persistent Cloudflare
Tunnel, and real user authentication in front of it. Never put provider API
keys into a publicly shared browser build.

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
| `GET  /api/models/library` | Local-app-only installed/catalog/storage report |
| `POST /api/models/install` | Local-app-only resumable portable install |
| `POST /api/models/verify` | Local-app-only full file verification |
| `POST /api/models/unload` | Local-app-only unload one model (`model`) or every loaded model (`all`) from RAM/VRAM |
| `POST /api/research` | Start a local-model Quick or Deep research run |
| `GET /api/research/:id` | Read local-only research progress or a saved report |
| `DELETE /api/research/:id` | Cancel an active research run |

Point any OpenAI client at base URL `http://localhost:5173/v1`.

## Model CLI

Manage models without the UI:

```bash
npm run models                      # list installed models
node tools/model-cli.mjs list --json
node tools/model-cli.mjs pull llama3.2:3b --url http://127.0.0.1:11435
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
| `RESEARCH_SEARXNG_URL`| *(unset)*                | Optional SearXNG search endpoint; otherwise DuckDuckGo with Bing RSS fallback |

## Tunnel mode

`npm run tunnel` starts the server with `--mode tunnel`. If `cloudflared` is
not found on `PATH` (or in `data/bin/`), it is automatically downloaded from
GitHub Releases. The public trycloudflare URL is printed to the console.

> Note: quick tunnels are ephemeral — the URL changes each run. Do not use
> them for long-lived public exposure without additional security (set
> `AUTH_TOKEN`).
