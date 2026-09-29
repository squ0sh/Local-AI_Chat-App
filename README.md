# Capsule

Portable. Private. Local AI.

Capsule runs an AI assistant on your own computer. Your chats and local memory
can stay on your machine, and ordinary local chat needs no cloud AI account.

## Quick start

Download the package for your computer from the
[official GitHub Releases page](https://github.com/squ0sh/Local-AI_Chat-App/releases).
Unzip it into a folder you can write to, then:

| Computer | Open |
| --- | --- |
| Windows x64 | Extract → double-click `start-portable.cmd` |
| macOS Intel | Extract → double-click `Local AI Chat.command` |
| Linux x64 | Extract → open `Local AI Chat.desktop`; approve Allow Launching if prompted |

Each ZIP has a platform-specific **START HERE** text file. Linux file managers
that do not launch desktop entries can use `bash start-portable.sh` from the
extracted folder. Capsule is not Apple-notarized: macOS may block downloaded
code. Do not disable Gatekeeper or remove quarantine attributes; see Apple's
[downloaded-app guidance](https://support.apple.com/en-us/102445).

Capsule checks its protected files as it starts, prepares its local engine,
and opens the chat. On the first run, choose the model marked **Best fit** in
**Model library** and approve its displayed download size. Downloading a model
needs an internet connection; chatting with an installed model works offline.
The [short friends and family guide](FRIENDS-AND-FAMILY.md) covers setup and
recovery without technical commands.

## What Capsule can do

- **Think:** local chat, model choices, research, and reviewed agent tasks.
- **Remember:** chats, local memory, procedures, and reviewable summaries.
- **Act:** approved file and command tools, voice, images, and optional MCP tools.
- **Connect:** temporary Remote links, peer transfers, and portable USB copies.

## Privacy and safety

Local chat and local memory stay on this computer. Web research visits public
sites; optional cloud providers receive the prompts sent to them; Remote and
peer features transmit data you choose to share. Browser and operating-system
speech services may use a network connection. Review a model's source and
license before sharing its files.

**Verified release** in the sidebar means the protected app files passed the
signed manifest check. It does not establish that the downloaded ZIP came from
the expected publisher by itself. Compare the release key fingerprint below
with the one on the official repository page if you need independent release
identity. **Development build** means official release verification is not
enforced. If verification fails, Capsule stops and explains how to get a clean
copy. Advanced diagnostics remain available in the terminal.

Official release public-key fingerprint (SHA-256 of the Ed25519 SPKI key):

```text
c2d5bf55d9d4a1167c15cc64f03b683af6b85d8c770b9cdb5367739390e84ba5
```

This value is published in the repository, outside the downloadable ZIP. It
cannot defend against a compromised GitHub account or signing key. See
[Security and release trust](SECURITY.md) for the exact boundaries.

To verify a downloaded ZIP before opening it, download its matching `.sha256`
and `.sha256.sig` files and run `node tools/verify-archive.mjs /path/to/Capsule-vVERSION-PLATFORM.zip`
from a trusted source checkout. Compare the printed key fingerprint with the
one above. The archive verification is separate from Capsule's startup check.

## Models and hardware

The Model library checks free memory and storage, then marks a best fit.
The recommendation is an estimate, not a speed guarantee. Large choices may
run slowly or need more memory; the app shows download size before you start.
Installed models use disk space and can be unloaded from memory without being
deleted. Advanced choices are still available in the library.

## Advanced users

The sections below document the local OpenAI-compatible API, agent tools,
portable layouts, runtime pins, signing, and environment controls. Ordinary
setup does not require them.

## Sharing modes

### Portable USB kit

The current official release targets Windows x64, Linux x64 and Intel macOS.
The builder retains ARM64 support for development, but no ARM64 ZIP is part of
this release. Each ZIP contains only its platform's launchers/runtime plus
explicitly allowlisted shared application files and user documentation.
Use `start-portable.sh` on Linux/macOS or double-click `start-portable.cmd` on
Windows. The launcher selects a matching bundled Node and Ollama runtime; it
never silently falls back to host-installed software.

Launchers open your browser automatically once the app answers
(`LOCAL_AI_NO_BROWSER=1` disables that). Windows uses `start-portable.cmd`;
macOS uses `Local AI Chat.command` from Finder, subject to Gatekeeper approval.
Linux uses `Local AI Chat.desktop` where supported; executable permissions and
"Allow Launching"/trust approval may be required. File managers differ, and
noexec-mounted drives cannot run the bundled binaries. The reliable Linux
fallback is `bash start-portable.sh`. `bash tools/register-menu-entry.sh` adds
an optional Linux app-menu icon (`--remove` to undo); re-register after moving
the folder. Extract to a local path rather than a virtual/URI-only location.

Models, settings, logs, and tunnel tooling stay under `.portable/`, so the app
does not touch the host's Ollama library or require a system Node installation.

The platform ZIP includes these pieces beside the launchers:

```
runtime/platforms/       # runtime for the ZIP's named platform
.portable/ollama/models/ # models downloaded after first launch
```

Model files are usually much larger than the app. The normal ZIP leaves model
choice to the person running it; a model is downloaded only after approval.

Use exFAT, NTFS, or a Linux filesystem for a flash drive. FAT32 cannot store an
individual file larger than 4 GB, which many AI models exceed. A drive mounted
with `noexec` cannot launch binaries in place; copy the Capsule to a local
folder in that case.

**Or let the app build the stick for you.** The *Pack → Copy everything to a
USB drive* section detects removable drives (with free-space and filesystem
warnings), prices every payload in GB — models, voice, image engine, runtimes —
lets you tick what to carry (private data stays behind unless you opt in), then
streams a byte-verified, resumable kit to the drive. On the other machine it is
one command: `bash start-portable.sh` (Linux/macOS) or `start-portable.cmd`
(Windows).

### Run it as a service

The portable kit is also the service artifact — same folder, same
`start-portable.sh/.cmd`, same `.portable/data`. One command per platform:

| Platform | Install | Uninstall | Notes |
| -------- | ------- | --------- | ----- |
| Linux    | `bash tools/service.sh install`     | `bash tools/service.sh uninstall` | systemd **user** service (`~/.config/systemd/user`); one-time `loginctl enable-linger "$USER"` keeps it up across sign-outs |
| macOS    | `bash tools/service.sh install`     | `bash tools/service.sh uninstall` | launchd LaunchAgent (`~/Library/LaunchAgents`); auto-starts at login |
| Windows  | `tools\service.cmd install`         | `tools\service.cmd uninstall`     | Task Scheduler task at logon |

Each installer runs the integrity check first, refuses an open service unless
`AUTH_TOKEN` is set or a multi-user account exists (`--allow-open` overrides
that deliberate risk), and installs with `LOCAL_AI_NO_BROWSER=1` so nothing
pops on a headless box. `status` and `logs` tell you whether the app answers —
not just whether the process is up. Uninstall removes the service definition
only; **data and models stay** in `.portable/data`, so the kit can go back onto
a stick at any moment.

The macOS and Windows generators are shaped as one-line recipes both verified
by tests here and verified-for-real when you run them on that platform; if
something misbehaves, `tools/service.cmd` and the plist are plain text with
full read-back. A root system service (`/etc/systemd`, `/opt`, `/var/lib`)
remains a documented manual path for now.

**Upgrade a deployed service:**
`node tools/capsule-backup.mjs` → swap the kit (or `git pull`) → `systemctl
--user restart local-ai-capsule` (or re-run the installer) → the launcher
verifies the signed manifest on start; a restore rolls back with the same
backup file. No auto-updater — the manifest is the version contract.

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

Agent Mode starts with plain language. Turn on **Use Agent Mode**, and the Start
screen offers a few one-click starters: **Start a task** (describe anything),
**Ask my files** (answers that cite your project), **Text tools** (draft,
summarize, polish, or translate in one card), and **Organize my files** (sort a
folder by year or type — preview the plan, approve, and **Undo** any move
afterwards). The **🧐 Critic** chip adds a second-opinion pass: a fresh-context
review of the draft (or plan — plans are reviewed before you approve them),
and a revision when the review finds real issues; it is on by default for small
models (≤ ~4 GB), where it matters most, and always one click to toggle. Deep
Research, Skills, a model-readiness check, and **Our Norms**
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
changes a model you have chosen yourself. Fit also suggests the best
**installed** model: on a fresh start, before any model has been picked, the
chat selector opens on the Fit-best installed model, and switching Fit level
re-selects it — but only until you choose a model yourself, which Fit always
keeps. In the Fit card, a suggested model that is already installed offers
**Use this model**; one that is not installed offers **Install (~N GB)**,
which opens the Model Library and starts the download there.

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

### MCP servers (local only)

The agent can plug into any local MCP-compliant tool server. Open the **Agent**
dialog, find the **MCP server** panel, enter a command (for example
`node /path/to/server.mjs` or `npx my-mcp-server --flag`), and connect. Connected
servers and their tools appear in the panel; the terminal lists and calls them
with `/mcp` (and `/mcp call <client> <tool> <json>` after a confirmation).
Servers run over JSON-RPC stdio under the hood (see `lib/mcp-client.mjs`), and
the HTTP routes behind the panel (`/api/agent/mcp/register|list|call|unregister`)
are available only from the local app — never over Capsule Remote.

MCP registrations are governed because they start real processes:

- Registered commands must match `CAPSULE_MCP_ALLOW` (default `node,npx,uvx`;
  comma-separated executable basenames, or exact paths).
- Children start with a **hermetic environment** — `PATH` and home only — so
  child servers never see your `AUTH_TOKEN`, provider keys, or data paths.
  Secret-looking user env keys (matching `key|token|secret|passw`) are refused
  outright; the old `CAPSULE_MCP_INHERIT_ENV` switch is ignored. If a server needs
  inheritance.
- Registration is blocked while plan mode is on.
- Flooding servers are cut off (8 MB stdout limit), tool results larger than
  1 MB are refused, crashed servers are revived transparently on the next call,
  and every register/call/unregister/restart is journaled to
  `data/agent/mcp.log`.

**The agent can use them too.** Registered tools appear to the model as
`mcp_<server>_<tool>` in Build and Code modes; each tool call pauses on an
approval card showing the server and the raw arguments before anything runs,
and rejections are explained to the model instead of crashing the run. Plan
mode never offers them, and a crashed server revives silently before the call
fails. Two servers that export the same tool name are refused at registration
with a `409` naming the clash, so the model's tool table never shadows.

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

The **Machine** entry in the Capsule sidebar is *body telemetry*: live CPU,
memory, temperature, fan, and (where the box reports it) battery, plus an
honest estimated-watts readout tied to AI work the capsule just ran (the
sampler adapts to 1 Hz while a job cooks, 60 s otherwise). "Why is that?" asks
the local model to explain the last minute in plain language, with the burn
attributed to the exact job that did it (chat, image, research). Everything
stays on disk — this is **your own machine's telemetry**, the mirror image of
vendor monitoring: nothing is reported anywhere.

### Capsule Memory

The **Sleep cycle** entry runs an overnight-style consolidation: the capsule
digests what changed into proposals — memory facts, reusable procedures — and
presents them next morning in an approval queue with citations. You accept or
dismiss each; nothing writes until you click.

The **Peers** entry opens capsule-to-capsule handshakes: pair two capsules by
exchanging signed cards (QR-able, typeable 6-word safety phrase, or pasted
frames), then trade memory facts and procedures as **postcards** over any
medium. A **Transports** panel in the dialog shows every carrier at a glance,
and each one lands in the same consent inbox:

- **Bridge** — a USB stick or a drop folder. The watcher runs from boot; your
  postcard writes into `outgoing/` and the far capsule picks it out of its
  `incoming/` (set a shared path with `CAPSULE_BRIDGE_DIR`).
- **Light** — screen-to-camera QR. One code per frame, auto-advanced for the
  receiver; the other capsule reads them with its camera (jsQR decodes in-page)
  with zero radio hardware.
- **Sound** — speaker-to-microphone data-over-audio. Pure-DSP FSK tones near
  16–19 kHz; each burst is a frame and the mic decodes it live.
- **Radio** — any `meshtastic`-style CLI: set `CAPSULE_RADIO_CMD`, a receive
  command, and a poll interval (`CAPSULE_RADIO_RECEIVE_CMD`,
  `CAPSULE_RADIO_POLL_MS`, default 15 s). Frames ride as text — or, on ham
  radio, as a deliberately sign-only (`QM1`) frame that refuses to encrypt.
- **LAN** — the live encrypted sync already described below.

Received items always wait in an approval inbox; nothing lands silently.

**Brain escrow** (in the same sidebar) fixes the "my machine died and took my
memory with it" problem without a cloud: your memory index + procedures are
sealed into one small blob, the wrap key is **Shamir-split k-of-n across
friends' capsules**, and each shard travels as a consent-gated postcard.
Single shards are information-theoretically worthless, a roster of holders is
visible to you from the Escrow panel, and the build sequence makes even the k
friends useless without your recovery passphrase (`brainKey XOR scrypt(pass)` —
the AEAD tag catches a wrong one). Everything is journaled in the peers
handshake log as it happens.

The **Memory** entry in the Capsule sidebar turns on private long-term recall:
your chats and research reports index into an encrypted store on this machine,
so the agent can answer "what did we decide about X?" with links back to the
exact conversation. A small local reader model enables meaning-based search
(one guided download); without it, keyword recall still works. Memory is
local-only by construction — it is structurally impossible for it to ride a
cloud chat payload — and "Forget everything" destroys the index and its key.

### Live Voice

Press the microphone icon to open the full Voice Mode screen. It shows the
selected model, live transcript, and clear Listening, Thinking, Speaking, and
Muted states, with a **speech language** picker (used by browser speech
recognition and by offline whisper alike) and a **voice** picker listing every
installed Piper voice and Kokoro persona. Use Mute to pause the microphone, tap
the animated orb to interrupt speech, or choose End voice to return to chat.
Voice Mode listens for one utterance, sends the transcript, and speaks the
model's response — starting with the first finished sentence and prefetching
the next chunk while playback runs, so long answers flow without pauses. It
keeps the screen awake when supported, and prefers a local enhanced/neural OS
voice when one is available.

The selected Ollama model remains the conversational model, so the spoken
answer has the same behavior as typed chat. On browsers without speech support
the app offers a guided one-time **offline voice install** (piper + whisper.cpp,
progress-bar download, fully on-device afterwards). The microphone indicator is
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

Three tunnel flavors are supported:

- **Quick** (default) — `npm run tunnel`. Ephemeral `*.trycloudflare.com` URL.
- **Tailscale Funnel** — `npm run tunnel:tailscale`. Publishes to your tailnet's
  `https://…ts.net` name; requires a logged-in Tailscale on this machine.
- **Named Cloudflare tunnel** — `TUNNEL_NAME=my-tunnel npm run tunnel:named`.
  Uses a tunnel already created with `cloudflared tunnel create`; the URL stays
  stable across restarts.

All flavors still require `AUTH_TOKEN`. For a local-only box that should never
send anything off-device, add `CAPSULE_DENY_EGRESS=1` — the cloud provider
proxy and research web access are refused before any request leaves this
machine.

### Multi-user accounts (optional)

By default the Capsule is a single-operator app. To gate the whole surface
behind real sign-ins — each user with their own encrypted chat history under
`data/users/<name>/chats/` — create at least one account:

```bash
node lib/user-store.mjs create alice "a long memorable password"
```

On the next start the app detects `data/users.json`, shows a sign-in dialog,
and locks every `/api/*` and `/v1/*` route until a session is issued (bearer
token and HttpOnly cookie both work; sessions last 10 hours). Passwords are
scrypt-hashed, the file is written 0600-aware atomically, login attempts ride
the same rate limiter as the chat API, and Capsule Remote is refused in this
mode. Put the accounts file somewhere else with `CAPSULE_USERS_FILE`.

Delete `data/users.json` to go back to single-operator mode.

### Cloud providers (optional) — including FreeLLMAPI

The **Cloud** button connects the app to OpenAI, Anthropic, or Google Gemini
with your own key (session-only by default), or to **FreeLLMAPI**, a free-LLM
router that runs on your machine and serves a dashboard at
`http://localhost:3001`. Cloud mode keeps local chat history, projects,
documents, and agent tools private — only the message you send goes out — and
the status row in the dialog tracks the router with guided install steps if it
isn't running yet. When cloud mode is on through a loopback router, the Cloud
button turns into a visible warning if the router stops answering.

- Zero dependencies — runs on Node's built-ins (Node 18+).
- Clean single-file web chat UI.
- Thin passthrough proxy to Ollama's own `/v1` OpenAI-compatible endpoints,
  so any OpenAI client (OpenClaude, chat SDKs, etc.) can point at local models.

## Quick start

```bash
# Local only (default)
npm start
```

Then open the app — actually, it opens your browser for you once it's ready
(set `LOCAL_AI_NO_BROWSER=1` to prevent that). If it's already running, the
launcher simply opens it and exits. The welcome screen's **Get set up** card checks the engine,
offers a one-click install of the model that fits this machine, and links the
optional extras (vault backup, offline voice, image generation, free cloud
routing). Sending a message with no model installed shows the same guided
install right in the chat.

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
| `POST /v1/responses` | Responses API (passthrough to OpenAI provider; translates to the local model otherwise) |
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

Core:

| Variable              | Default                  | Description                          |
| --------------------- | ------------------------ | ------------------------------------ |
| `OLLAMA_URL`          | `http://127.0.0.1:11434`| Ollama API base URL                  |
| `PORT`                | `5173`                 | Local AI Chat listening port         |
| `HOST`                | `127.0.0.1`            | Bind address; use `0.0.0.0` for LAN access |
| `OLLAMA_API_KEY`      | *(unset)*                | Upstream auth bearer (if Ollama gated) |
| `OLLAMA_MODELS`       | *(unset)*                | Override the Ollama model-library location |
| `AUTH_TOKEN`          | *(unset)*                | Require `Authorization: Bearer` on this server |
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

Runtimes and portable data:

| Variable                  | Default          | Description                          |
| ------------------------- | ---------------- | ------------------------------------ |
| `LOCAL_AI_DATA_DIR`       | *(portable layout)* | Fully self-contained data directory |
| `LOCAL_AI_NODE_BIN`       | *(auto-detect)*  | Explicit Node runtime binary         |
| `LOCAL_AI_OLLAMA_BIN`     | *(auto-detect)*  | Explicit Ollama runtime binary       |
| `LOCAL_AI_NO_BROWSER`     | *(unset)*        | Launchers will not auto-open the browser |
| `LOCAL_AI_AUTO_DOWNLOADS` | *(unset)*        | Skip the launcher runtime prompt and re-download quietly |
| `LOCAL_AI_USB_SCAN_ROOTS` | *(auto)*         | Override removable-drive scan roots for the USB builder (path list, `;` on Windows) |
| `LOCAL_AI_PEER_PORT`      | `45917`          | UDP/TCP port for Peers LAN discovery and sync |

Tunnel, cloud, and egress:

| Variable                 | Default            | Description                       |
| ------------------------ | ------------------ | --------------------------------- |
| `TUNNEL_TYPE`            | `quick`            | Tunnel flavor: `quick` (ephemeral trycloudflare), `tailscale` (Funnel), `named` (persistent Cloudflare tunnel) |
| `TUNNEL_NAME`            | *(unset)*          | Tunnel name when `TUNNEL_TYPE=named` |
| `CLOUDFLARED_PATH`       | *(auto-detect)*    | Path to cloudflared binary        |
| `CAPSULE_DENY_EGRESS`    | *(unset)*          | With `1` (or `--deny-egress`), refuse any upstream whose host is not loopback; research needs no outbound traffic either. Denials are journaled to `data/egress.log` |
| `FREELLMAPI_CMD`         | *(unset)*          | Explicit FreeLLMAPI router start command (plus `FREELLMAPI_ARGS`) |
| `FREELLMAPI_DIR`         | *(auto)*           | Router install directory          |
| `FREELLMAPI_DESKTOP`     | *(auto)*           | Router desktop app path           |

Multi-user and speech:

| Variable              | Default                    | Description                        |
| --------------------- | -------------------------- | ---------------------------------- |
| `CAPSULE_USERS_FILE`  | `data/users.json`          | Accounts file enabling multi-user mode |
| `WHISPER_CLI`         | *(auto-detect)*            | Path to a whisper.cpp binary       |
| `WHISPER_MODEL`       | `models/whisper/ggml-base.bin` | Whisper STT model file          |
| `PIPER_CLI`           | *(auto-detect)*            | Path to a piper binary             |
| `PIPER_VOICE`         | `models/piper/voice.onnx`  | Piper TTS voice file               |

Integrity and hardening:

| Variable                     | Default   | Description                         |
| ---------------------------- | --------- | ----------------------------------- |
| `CAPSULE_ALLOW_UNSIGNED`     | *(unset)* | Obsolete and ignored; use explicit `CAPSULE_DEV_MODE=1` for a developer copy |
| `CAPSULE_ALLOW_INSECURE_BIND`| *(unset)* | Allow binding a tokenless server on a non-loopback host (dangerous; normally refused) |
| `CAPSULE_MAX_CONTEXT`        | *(auto)*  | Override the auto RAM-based `num_ctx` cap (min 1024) |
| `CAPSULE_RATE_PER_IP`        | `150`     | Per-client burst capacity of the shared API rate limiter |
| `CAPSULE_RATE_REFILL`        | `20`      | Sustained tokens/second the rate buckets refill at (600-request global burst) |
| `CAPSULE_MCP_ALLOW`          | `node,npx,uvx` | Executable allowlist for MCP server registration; comma-separated basenames or absolute paths |
| `CAPSULE_MCP_INHERIT_ENV`    | *(unset)* | Obsolete and ignored; MCP children receive a limited environment |
| `LOCAL_AI_EMBED_STUB`        | *(unset)* | Internal/test: memory embedder stub |

## Tunnel mode

`npm run tunnel` starts the server with `--mode tunnel`. If `cloudflared` is
not found on `PATH` (or in `data/bin/`), it is automatically downloaded from
GitHub Releases. The public trycloudflare URL is printed to the console.

> Note: quick tunnels are ephemeral — the URL changes each run. Do not use
> them for long-lived public exposure without additional security (set
> `AUTH_TOKEN`).
