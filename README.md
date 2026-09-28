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

`capsule-integrity.json` pins the shipped application, launcher, tool, test,
cloud, and runtime-metadata files with SHA-256 and an Ed25519 signature.
Embedded compressed copies allow a missing tracked file to be restored offline,
but only after the signed manifest validates. A missing/corrupt manifest is
never recreated automatically, and a changed file is never silently accepted.

Signed release mode is the default on every consumer computer. It needs only
`capsule-signing-pub.pem`; it does **not** look for the private release key.
Startup fails closed when the manifest is missing, unsigned, incorrectly
signed, incomplete, or does not match the files. The readiness panel may restore
a file from a valid signed manifest, but it cannot turn current files into a
trusted release.

Bundled runtimes also self-heal. `runtime/downloads.txt` pins the official
download URL plus archive and binary SHA-256 hashes for Node and Ollama on every
supported platform. When a bundled binary is missing or below its size floor, the
launcher asks once (`LOCAL_AI_AUTO_DOWNLOADS=1` skips the prompt), downloads to
`.portable/cache/`, verifies the archive hash, and extracts it. Pass
`--verify-runtimes` to either launcher to hash the existing Node and Ollama
executables against the release pins and run a `--version` smoke check.
Ollama support libraries are verified as members of the pinned archive when
installed, but are not individually re-hashed by that flag.

Anyone can work on the Capsule without the release key:

- Explicitly opt into developer mode, regenerate an unsigned developer
  manifest, and launch with the same opt-in:

  ```bash
  CAPSULE_DEV_MODE=1 npm run integrity
  CAPSULE_DEV_MODE=1 npm run server
  ```

  On Windows Command Prompt, use `set CAPSULE_DEV_MODE=1` first. The obsolete
  `CAPSULE_ALLOW_UNSIGNED` variable is ignored.

Release builds are signed with the private key (`~/.capsule-signing/key.pem`,
never committed). Keep that key on the release machine only; consumers ship and
verify against the public key. `npm run integrity` is the explicit release
generation/signing command when that key is available. Runtime code and the web
UI cannot access or invoke the private signing key.

A versioned pre-commit hook can require that an explicitly regenerated manifest
is staged with guarded changes. It intentionally does not execute signing code:

```
npm run hooks:install
```

It also refuses a guarded file with both staged and unstaged edits.
`npm run integrity:check` validates exact coverage, hashes, and signature
without writing and is part of `npm run ci`.

The signature detects partial modification after a trusted acquisition. The
public key, launcher, verifier, and manifest are stored together in the
Capsule, so a completely replaced package can replace that whole trust set.
For provenance, compare the public-key fingerprint or release checksum with a
value published outside the USB/package (for example, a signed release page).

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

Agent Mode starts with plain language. The **Start** screen (open the Start
button, or `/start`) turns on **Use Agent Mode**, then offers one-click
starters: **Ask my files** (answers that cite your project), **Write something**,
**Improve my writing**, **Summarize**, **Translate**, and **Organize my files**
(sort a folder by year or type — preview the plan, approve, and **Undo** any
move afterwards). Research, Skills, and a model-readiness check stay one click
away, and the Deep Research panel remains available through `#agent-start-research`
and `/research`.

Each chat keeps its own agent memory: the conversation the agent saw is saved,
and relaunching a task in the same chat continues from where you left off. A new
chat starts fresh. `/help` and `/forget` clear that memory.

The **Tools** button beside the message bar opens the optional `/` command menu;
the same commands also run from the Start screen's terminal field, which lives
under Advanced together with a **Write a file** panel and MCP server
registration. `/help` lists everything; the most useful ones:

- `/start` — reopen the friendly Start screen.
- `/grep <pattern>`, `/find *.<ext>` — search file contents or file names.
- `/git status`, `/git diff` — read-only git, allowlisted, no force pushes.
- `/test`, `/test <name>` — run the test suite (or just matching tests).
- `/plan <task>` — draft a plan first, then `/go` to execute it.
- `/undo` — reverts the agent's last file change (writes and moves).
- `/forget` — clear this chat's agent memory.
- `/search <topic>`, `/research <topic>` — web search and cited deep research.
- `/ask <question>` — a plain chat turn with no tools involved.
- `/env` — show model, tunnel, and workspace context.

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

### Share over the web

**Capsule Remote** creates a temporary private link and QR code. The complete
link includes a high-entropy key under `/remote/...`; the bare Cloudflare
hostname is intentionally incomplete. A guest gets a fresh UI with no owner
chat history, no model/settings/agent/research/portable controls, and access
only to local Ollama inference. Owner cloud-provider credentials are never used
for Remote requests. Stop Remote when sharing is finished; quick-tunnel URLs
and their keys are temporary.

Remote is disabled when multi-user accounts are configured. For durable public
hosting, use a named tunnel or reverse proxy with HTTPS and real authentication
rather than treating a quick tunnel as a permanent service.

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
| `CAPSULE_DEV_MODE`   | *(unset)*                | Explicitly allow an unsigned developer manifest |
| `CAPSULE_DENY_EGRESS`| *(unset)*                | Block non-loopback cloud/research network egress |
| `LOCAL_AI_DATA_DIR`  | `./data`                 | Settings, encrypted chat state, users, research, and temporary speech files |
| `CAPSULE_USERS_FILE` | `<data>/users.json`       | Optional multi-user account store |

## Security and data boundaries

- Local controls trust the actual loopback socket peer, not the HTTP `Host`
  header. Browser control requests must be same-origin; wildcard CORS is not
  enabled.
- Remote guests can chat with local models but cannot read the owner's saved
  chats, invoke agent/MCP tools, change models, run research, manage the tunnel,
  or spend owner cloud credentials.
- Chat state is encrypted at rest with a per-install key. Vault exports use the
  passphrase-based encrypted vault format. These protect copied storage, not a
  running unlocked process or an attacker who controls the host and key files.
- Agent file tools are confined to the project, reject symlinks, and block
  `.git`, `.portable`, environment, key, and vault paths. Git inspection uses
  a strict read-only grammar. Approved shell commands and MCP servers still run
  as the current OS user: approval is a security boundary, not an OS sandbox.
- MCP child processes receive a small environment allowlist rather than all
  application/API secrets. Registration and each direct tool call require an
  explicit UI approval, and malformed/oversized MCP output is terminated.
- Deep Research and Agent web fetch accept public HTTP(S) targets only, recheck
  redirects, block local/private/link-local destinations, and cap time/body
  sizes. Set `CAPSULE_DENY_EGRESS=1` for an offline-only session.

## Tunnel mode

`npm run tunnel` starts the server with `--mode tunnel`. If `cloudflared` is
not found on `PATH` (or in `data/bin/`), it is automatically downloaded from
GitHub Releases. The public trycloudflare URL is printed to the console.

> Note: quick tunnels are ephemeral — the URL changes each run. Do not use
> them for long-lived public exposure without additional security (set
> `AUTH_TOKEN`).
