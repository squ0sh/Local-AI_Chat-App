# Changelog

## 1.14.0 — Machine body telemetry: the capsule can feel itself

- **New sidebar Machine card.** Live CPU %, RAM, temperature, fan, battery,
  estimated watts, and active AI jobs on a sparkline; "Why is that?" asks the
  local model to narrate the last minute (with the burn attributed to the exact
  job) instead of scanning a ghost dashboard. Everything is read from
  `/proc`/`hwmon` and journaled under `data/telemetry/` — your machine's
  telemetry is yours again.
- **Adaptive sampling.** ~1 Hz while a job cooks, once a minute when idle; the
  in-memory ring caps at 48 hours and the journal writes one line per sampled
  minute, so a long conversation costs exactly what it costs.
- **No egress by posture.** `/api/telemetry/*` answers only to the local app
  (loopback + same-origin) and never calls out — no exception URL, no remote
  view. The information-locked guarantee is test-pinned.
- 9 unit tests for the parsers, watts model, ring capping, and job sharing;
  1 HTTP route test; 3 browser probes. Suite: 188 / 72 green.

## 1.13.0 — Brain escrow: social recovery, no cloud

- **Your Capsule's brain can survive the house fire.** Memory index + procedures
  now pack into one small sealed blob; its wrap key is Shamir-split k-of-n
  (default 2-of-3) and each shard ships to a friend's capsule as a sealed
  CAPX1 postcard — riding the same trust-list and consent inbox as everything
  else. Holders see only the shard they keep; only you see the whole roster.
- **Two-factor by construction, not by policy.** The payload is sealed with
  `brainKey XOR scrypt(recovery passphrase)`: shards alone give nothing, the
  passphrase alone gives nothing, and the AEAD tag punishes a wrong phrase.
- **Every step is consent—and—journal.** Friends approve shard-keeping in the
  same pending-card grammar as procedures; recovery requests reach holders as
  postcards too. A fresh Capsule re-pairs, gathers k envelopes, and walks
  `Escrow → Rebuild brain` to prevail.
- The new `lib/escrow.mjs` (pure GF(256) Shamir, KAT-tested) plus
  `/api/escrow/{status,create,revoke,recover/*}` rides the loopback-only guard
  — and the whole Escrow flow is covered by 10 new lib/HTTP tests and 3 browser
  probes (178 / 69 green).
- The signed manifest now tracks every runtime library it actually protects
  (`capsule-handshake`, `capsule-net`, `capsule-memory`, `consolidation`,
  `escrow`, `mcp-client`, `user-store`, `agent-loop`, `memory`, …, 52 files).

## 1.12.0 — MCP tools join the agent

- **Registered MCP servers are now agent tools.** Every connected server's
  tools appear to the local model as `mcp_<server>_<tool>` (names sanitized and
  capped for model limits), right beside read/write/list/run — far more useful
  than manual `/mcp` invocations from the terminal.
- **Universal approval gating, no exceptions.** Every `mcp_*` call pauses on
  the existing approval card regardless of autonomy mode (supervised, selective,
  *auto*) — external processes keep host powers, so the human decides every
  single time. Rejections are narrated back to the model instead of failing the
  run, and plan mode doesn't surface them at all.
- **Crash-transparent dispatch.** Calls route through the hardened client's
  auto-revive: register-name collisions across servers are refused with a `409`
  at connect time, and agent-side calls land in the same
  `data/agent/mcp.log` journal as terminal `/mcp` calls (marked `via: 'agent'`).
- **Proven end to end**: 9 new loop-level + full-HTTP tests drive a register →
  model tool call → approval card → server tool call sequence and its
  mirror (rejected call never runs, the rejection is journaled). Suite is at
  166 passing; 66 browser probes green.

## 1.11.0 — Deployment story: the Capsule runs itself, and stays portable

- **`tools/service.sh` (Linux + macOS) and `tools/service.cmd` (Windows)** turn
  the same portable kit into a per-user background service: systemd user unit /
  launchd LaunchAgent / Task Scheduler task, all launching the unchanged
  `start-portable` launcher with `LOCAL_AI_NO_BROWSER=1`, `Restart=on-failure`
  hardening, and an auth gate — a service without `AUTH_TOKEN` or a multi-user
  account refuses unless you pass `--allow-open` deliberately. Every write is
  sandboxed behind `XDG_CONFIG_HOME`/`LOCAL_AI_AGENT_DIR` overrides and a
  `--dry-run` mode, so the installers are fully testable (7 new tests cover
  unit-content hardening, auth gating, uninstall never touching data, the
  launchd plist shape, and the schtasks wrapper).
- **Nothing about portability changes.** `.portable/data` is the service's data
  dir; `uninstall` removes the service definition and leaves models + history
  in place; a deployed kit can be zipped back onto a USB stick at any moment.
  The service installer surfaces in the signed manifest like every other
  release tool.
- **README grows the operational section**: a platform table for installing,
  the upgrade/rollback recipe built on the shipped `capsule-backup` snapshot
  and the signed manifest (no auto-updater — the manifest is the contract) —
  and the root-owned system service left as a documented manual path.

## 1.10.0 — MCP hardening + voice polish

### MCP hardening

- **Allowlist-gated registration.** `/api/agent/mcp/register` refuses any
  executable not in `CAPSULE_MCP_ALLOW` (default `node,npx,uvx`; absolute paths
  must resolve to a listed name or exact path), and plan mode now blocks
  registration just like tool calls — registering spawns a real process.
- **Hermetic child environments by default.** MCP servers now receive `PATH` +
  home only, so host secrets (`AUTH_TOKEN`, provider keys, data paths) can't
  leak into tool servers. Caller-supplied env keys that look secret-bearing are
  rejected. `CAPSULE_MCP_INHERIT_ENV=1` restores full inheritance when needed.
- **Scream-proof client.** An 8 MB stdout buffer cap cuts off flooding servers
  (and kills them), tool results larger than 1 MB are refused, `close()`
  escalates SIGTERM → SIGKILL, and a crashed server is **revived transparently**
  on the next list/call with its original spec.
- **Audit journal.** Every register / unregister / call / respawn lands in
  `data/agent/mcp.log` (size-capped), so you can always answer "who started
  what, and did it work?"

### Voice polish

- **Speech language picker** in Voice Mode (Auto plus English, Español,
  Français, Deutsch, Italiano, Português, Русский, 日本語, 中文, العربية,
  हिन्दी). One setting drives both browser speech recognition and the offline
  whisper fallback, and is remembered per machine.
- **TTS voice picker.** The server now enumerates every installed Piper voice
  and, when Kokoro is installed, its persona presets; Voice Mode shows them all
  and remembers your choice. Voice names are allowlist-validated against the
  on-disk files, so a request can't pick a path it was never offered.
- **Prefetch playback.** While one sentence of the answer plays, the TTS for
  the next sentence is already being rendered — spoken replies feel noticeably
  more fluid, most of all with the larger Kokoro engine.

### Quality

- 4 browser probes cover the new pickers (66 pass); the MCP hardening adds
  9 tests across the client and the HTTP layer (150 pass). The shared
  `bootServer` test harness now creates nested seed directories.

## 1.9.0 — Server integration suite + README catch-up

- **An HTTP-level regression net.** A new `test/http-security.test.mjs` boots
  the real server in isolation against a hermetic in-process fake Ollama and
  pins the surfaces the library tests couldn't reach: the multi-user auth gate,
  login/logout with bearer + HttpOnly cookie flows, per-user encrypted chat
  stores, the brute-force rate limit on `/api/auth/login`, the privacy-flag 403
  plus its positive local-stream case, `CAPSULE_DENY_EGRESS` refusal, the
  `/v1/responses` item/tool translation and SSE event sequence, `/v1/*`
  passthrough streaming, and the MCP register/list/call/unregister routes over
  HTTP (14 tests; the suite is now 139).
- **Two real bugs the new suite caught.** `proxyV1`/`proxyCloud` iterated
  `['content-type', …]` with array destructuring, so the upstream `Content-Type`
  was never forwarded to `/v1/*` clients; and the shared rate limiter was built
  with the 150-token per-IP *capacity* also acting as the per-second *refill*,
  so bursts could never be denied — burst/refill are now a sustained 150/20 by
  default and operator-tunable via `CAPSULE_RATE_PER_IP` / `CAPSULE_RATE_REFILL`.
- Shared server-boot harness extracted to `test/helpers/server-harness.mjs`
  (ephemeral port, tmp `DATA_DIR`, isolated `HOME`, users/seed-file fixtures);
  the cloud-router suite moved onto it unchanged; `test/helpers/fake-ollama.mjs`
  is the small reusable OpenAI+native-API stub.
- README update: the environment table grew long-missing rows (multi-user,
  tunnel types, deny-egress, Peers/USB knobs, whisper/piper paths, runtime
  pins), the endpoint table documents `/v1/responses`, a MCP section covers the
  Agent dialog panel and `/api/agent/mcp/*`, and a short *Multi-user accounts*
  section explains enabling sign-in mode and its isolation guarantees.

## 1.8.1 — Capsule↔Capsule handshakes (postcards over anything)

- **A peer protocol that doesn't care how it travels.** Every exchangeable
  thing (a contact card, a memory fact, a procedure, a note) ships as a signed
  CAPX1 envelope that fragments into copy-pasteable frames — the same text
  fits a LAN session, a USB stick, a QR sheet, a Meshtastic chat, or a
  ham-radio packet (sign-only mode there, because ham rules ban obscured
  content). Postcards addressed to a known peer are sealed with X25519 +
  AES-256-GCM; nobody else reads them.
- **Trust by meeting, not by server.** Devices pair by exchanging self-signed
  cards (six-word safety phrase included for out-of-band confirmation) and
  trusting on first sight; the trusted list and every handshake (sent,
  received, accepted, refused) journal to `data/peers/handshakes.log`.
- **LAN live sync that asks first.** "Become discoverable" announces the
  capsule over UDP; a direct session runs an authenticated X25519 handshake
  (badged by Ed25519 signatures with MITM-broken words check) and pushed items
  land in the receiver's **inbox as pending proposals** — the same
  approve/dismiss grammar as the sleep cycle. Untrusted senders are refused
  before any content is stored.
- New **Peers** dialog: my card (copy/download), paste-to-pair, one-click
  postcard composer + raw frame viewer, receive-paste with approval cards,
  LAN discovery + push flow with the six-word confirmation line.
- Verified by a real two-process live handshake on loopback (encrypted
  channel + consent gate proven), fragment reordering/mangling attacks
  rejected, sealed-vs-ham modes pinned, and temp files cleaned—the zombie
  smell from the old probe cleanup is gone.

## 1.8.0 — The Consolidation Cycle: the capsule sleeps on it

- **A "sleep on it" engine.** One click lets the capsule quietly digest what
  changed since the last cycle: durable memory facts and reusable procedure
  candidates are mined from recent chats and research, then staged as
  proposals in a **review queue** — nothing is ever written without your
  approval. Approving a memory feeds the encrypted local index; approving a
  procedure lands in your personal procedure library; dismissing is recorded
  with your reason. Cancellable mid-cycle, failure-safe (a dead model mid-run
  queues nothing), and every verdict is journaled to `consolidations.log`.
- The **Sleep cycle** panel (sidebar) shows the live phase, the queue with
  per-proposal source citations, and a calm written briefing when a cycle
  finishes. The sidebar entry itself badges while proposals await review.
- Model-busy guard: the cycle politely declines while a chat/agent run holds
  the local model, and the cycle takes the currently selected chat model (not
  an unrelated default) — fixed in the same pass.

## 1.7.0 — Capsule Memory: your capsule remembers, and can prove it

- **Local long-term recall with citations.** Chats and research reports index
  into an encrypted, on-device memory store; agent runs carry a `recall` tool
  and auto-context from it, and the critic now checks drafts against your
  precedent. Every recall lists its source (click a chat citation to jump back
  to the exact conversation).
- **Honest modes.** With the small reader model installed (~274 MB, one click
  from the Memory dialog) recall is meaning-based; without it, a transparent
  keyword fallback keeps working and says so. Purge = crypto-shred (index and
  key destroyed), and everything rides the USB kit only inside the explicit
  "Private data" payload.
- **Privacy contract, now with teeth and a test:** memory can *never* ride a
  cloud-bound payload — the injection lives strictly inside the local branch
  that already discards history for cloud mode, and the suite pins that
  statically.
- New Memory dialog in the sidebar: on/off, source stats, live Search preview
  with clickable citations, Reindex, and Forget everything. The setup
  checklist offers it as an optional extra.

## 1.6.3 — App-menu entries (Linux + macOS)

- `bash tools/register-menu-entry.sh` installs a real Linux app-menu icon
  ("Local AI Chat"), validated against desktop-entry rules; `--remove` undoes
  it. Writes only to the user's applications dir, never system paths. The
  launcher mentions it once until registered.
- macOS gains `Local AI Chat.command` — double-click from Finder/Spotlight
  launches the app (which now opens the browser by itself).
- Both entry points, the launcher, and the icon ship in the signed integrity
  manifest, so a stick copy carries them too.

## 1.6.2 — Launchers that open the app for you

- Running `start-portable.sh` (Linux/macOS) or `start-portable.cmd` (Windows)
  now **opens your browser automatically** the moment the app answers `/health`
  — no more watching a terminal and typing a URL. Set `LOCAL_AI_NO_BROWSER=1`
  on servers/SSH to keep it quiet.
- Launching twice is now friendly instead of scary: when the port already
  serves the app, the launcher prints “already running”, opens it in the
  browser, and exits cleanly instead of crashing on address-in-use.
- One-line progress prints on the way (“engine ready” → “app URL” → browser),
  so a cold start never looks frozen.

## 1.6.1 — Teach once: your capsule learns your procedures

- After any successful agent run (or reviewed plan), the completion card gains
  **📌 Save approach**: the run is distilled — task, tool trail, and what got
  done — into a small procedure card (name, summary, concrete steps) that you
  review and edit before saving. Offline or model-down, the dialog still opens
  with a template built from the actual tool trail, so the flow never blocks.
- **Procedures apply themselves politely.** When a new task resembles a saved
  procedure, a chip appears as you type (“You've done this before — use
  'Dependency update ritual'?”), one click attaches it to that run; an honest
  counter shows how often each procedure has actually been used.
- The Skills dialog gains a **Your procedures** section (name, summary, steps,
  use-count, Use/Delete), clearly separated from the verified built-in skills.
- Procedures live in `data/procedures.json` — your private data dir, atomic
  writes, size-capped, loopback-only API, never written into the integrity-
  sealed `skills.json`. On USB kits they ride along only with the explicit
  “Private data” payload.

## 1.6.0 — Critic Mode: the agent checks its own work

- New **🧐 Critic** chip in the agent bar. When enabled, the agent's draft
  answer (or its plan — plans are reviewed before you approve them) goes through
  a fresh-context second opinion with a strict rubric; a `PASS` ships the draft,
  real issues trigger a full revision streamed as its own card. The flow is
  **fail-open**: a critic that errors never blocks a good draft.
- On by default for small models (≤ ~4 GB — where single-pass mistakes hurt
  most), one click to override and the choice sticks. Roughly 2–3× slower per
  run when on; the chip says so in the tooltip.
- Terminal cards name what happened: “critic · draft looks solid” /
  “critic · found issues — revising” / “revision · applied”, and the final card
  reads “reviewed answer” when a revision landed. The chat transcript and agent
  memory keep the revised text.
- Everything rides one request flag end-to-end (`critic: true` → the loop's
  injected `llmCall` runs the extra passes as plain completions), verified by
  stubbed library tests (revise/pass/fail-open/event order) and browser probes.

## 1.5.1 — Docs catch-up + small mobile fixes

- README now documents the **Cloud / FreeLLMAPI** connection (privacy boundary,
  guided router setup), the guided USB-kit builder, the welcome-screen setup
  checklist, and the offline-voice install path (the voice section still
  claimed speech came only from the browser/OS).
- Mobile: the deep-research mode grid collapses to one column on small screens;
  setup-checklist card margins fixed. (Wider dialog sizing was already handled
  by the shared dialog rule; voice overlay and the model library had their own
  phone rules since earlier releases.)

## 1.5.0 — USB installer: the whole Capsule onto a stick, no copying by hand

- The Pack dialog gains a **“Copy everything to a USB drive”** section: it
  lists detected removable drives with free space and filesystem, sizes every
  payload live (models / voice / image / private data / per-platform
  runtimes), and builds a verified, ready-to-run kit at `capsule/` on the
  stick. FAT32 (>4 GB file) and `noexec` mounts are flagged before you start,
  free-space is preflighted, the copy streams with truthful progress, can be
  cancelled, and ends with a byte-for-byte verification pass plus a
  “what to run on the other machine” card (`bash start-portable.sh` /
  `start-portable.cmd`).
- **Privacy-by-default payload:** chats, vault, and cloud keys are never
  copied unless you explicitly tick them (with a visible why-not). Models,
  voice, and image engines are shown with their real sizes so you can fit the
  kit to the stick. A “Skip runtimes” choice leaves the stick to re-download
  its runtime on first boot — handy for small drives.
- Server side, everything rides the existing loopback-only `/api/portable/`
  gate as cancellable job endpoints (`usb-targets`, `usb-plan`,
  `usb-copy` GET/POST/DELETE) with the same storage/preflight primitives the
  model installer uses; arbitrary paths are refused — only enumerated
  removable drives are valid targets.

## 1.4.0 — Setup checklist on the welcome screen

- A dismissible **Get set up** card now lives on the empty-chat welcome screen:
  it checks the engine, models, vault backup, voice, image generation, and the
  FreeLLMAPI cloud option live, ticks what's done, and turns everything else
  into a one-click jump to its fix (model library, vault dialog, voice setup,
  image mode, cloud dialog). Once the engine and a model are in place the card
  stays quietly collapsed behind “Optional extras…”.
- Welcome suggestion chips now match the selected model's abilities — vision
  models get image prompts, coding models get code prompts, everyone else keeps
  the classic starters.

## 1.3.5 — Durable UI probes + loose ends

- New **`npm run ui-probe`**: a repeatable browser-level regression suite
  (isolated server + headless Chromium over CDP; skips cleanly when no Chrome
  is present). It guards the guided UX shipped in 1.3.2–1.3.4 — the first-run
  model nudge, humanized errors, the clickable engine-status dialog, launcher
  labels, the voice setup view, image-panel states, agent Retry buttons, the
  Remote fold, and the FreeLLMAPI router row (against a built-in mock). The
  /tmp-scratch probes from development are now 27 permanent assertions.
- **Attach-image is capability-aware**: attaching a picture while a text-only
  model is selected shows a heads-up bar (“<model> is text-only — it will
  ignore this image”) instead of failing mysteriously after send.
- Model library's *Installed* tab empty state now offers a **Browse recommended
  models** button instead of a dead panel; the cockpit's failure card got the
  humanized copy + a Retry button.

## 1.3.4 — Guided feature setup everywhere

- **Voice Mode onboards instead of alerting.** Tapping the mic without a model
  drops the chat's model-install nudge; unsupported browsers open the Voice
  overlay in a setup view that explains the one-time offline install and keeps
  the Install button front and center — gone are the `WHISPER_CLI` env-var
  alerts. The voice install itself is now a real progress bar with a friendly
  failure message and a Retry button (used to be a terse monospace `%` and
  "voice install failed.").
- **Image mode matches.** The image-stack install shows the same progress bar
  as model downloads, errors are humanized, and an empty gallery tells you
  what to expect (“…once the image engine is installed”) or offers a one-tap
  starter prompt once the form is live.
- **Agent failures are recoverable.** The load-timeout message no longer names
  a Retry action that didn't exist — a real **Retry** button now appears on
  failed/timeout agent cards, and failure text goes through the shared
  humanizer. Missing-model agent starts also trigger the model-install nudge.
- **Remote dialog decluttered.** The chat link + QR carry the whole story for
  normal use; the raw `API base` / `Access key` pair moved behind a collapsed
  “Advanced” details, and the idle state actually tells you what Start does.

## 1.3.3 — No dead ends: guided first run, friendly errors, live status

- **Sending without a model no longer dead-ends.** The chat shows a guidance
  row instead of a red error: it names the model that fits this machine
  (size included) and an **Install it for me** button that opens the Model
  library and starts the download. Your typed message stays in the input box,
  and the row updates to “press send again” once the model is ready.
- **Errors speak human.** A shared humanizer maps the common failure shapes
  (engine offline, rejected API key, missing model, rate limit, server error,
  over-long chat) to one plain sentence plus one fix button, replacing the
  `HTTP 500: {…}` dumps that used to land directly in the chat. Vault unlock,
  backup/restore, summarize, and Remote errors went through the same pass.
- **The status dot is now a button.** Clicking the bottom-left status (“Engine
  ready” / “Engine off — tap for help”) opens a dialog that explains in plain
  language what is running, what isn’t, and the one thing to do about it —
  including on a Remote link (“the link expired, ask for a fresh one”).
- **Sidebar launchers now report state.** Model library shows the installed
  count and live download percentage, the Vault button shows sealed/open, and
  the Remote button refreshes on its own (its live label was being clobbered
  by the sidebar rename). The empty model dropdown also points at the fix.

## 1.3.2 — FreeLLMAPI cloud connection

- The **Cloud connection** dialog gains a **FreeLLMAPI (local router)** provider.
  Point it at your router (base URL prefilled as `http://localhost:3001/v1`),
  paste the unified `freellmapi-…` key from the router's Keys page, and keep the
  model on `auto` so the router picks the smartest route for each request. The
  connection wires through the OpenAI-compatible endpoint and the mock-verified
  cloud plumbing (per-chat Data route still controls cloud vs. local sending).
- Fixed a latent bug in the `/v1/*` proxy: base URLs that already end in `/v1`
  (both `api.openai.com/v1` and any local router such as FreeLLMAPI) produced
  doubled `/v1/v1/...` request paths. A new `openaiUrl()` helper strips the
  leading segment correctly, so proxied model/upload/chat requests now reach the
  target at the right path.
- Fixed the Send button: `<button id="send">` creates a named `window.send`
  global that shadows the app's real `send` function, so clicking the arrow in
  cloud mode always threw `priorSend is not a function` (typing Enter worked,
  which is why it went unnoticed). The agent wrapper now resolves the app's
  send handler explicitly. The FreeLLMAPI end-to-end flow is covered by the
  offline mock router tests.
- While FreeLLMAPI is selected, the dialog shows a live **router status row**
  (loopback base URLs only) plus a state-aware guidance panel:
  Running links the dashboard and tells you exactly where the unified key lives
  (Keys page); installed-but-stopped offers **Start router**; missing Docker /
  stopped Docker / nothing installed each produce platform-correct next steps —
  a download link to the desktop installer on Windows/macOS (which the app can
  also launch itself once installed), or the copyable official one-liner
  (`curl -fsSL https://freellmapi.co/install.sh | bash`) on Linux. The app never
  downloads or executes anything by itself. The probe follows the Base URL
  field as you type (via a `?port=` override), so the status always reflects
  the address you're about to connect to, and the dialog copy now states
  plainly that FreeLLMAPI is a *local router for cloud providers*: keys stay on
  your machine, but messages still leave it. When cloud mode is on through a
  loopback base URL, the **Cloud** button flips to a visible
  "Cloud · router down" warning if the router stops answering, so silent
  failures can't hide.
  (The router itself is the Docker/desktop app — the npm package `freellmapi`
  is only a coding-agent setup CLI and cannot serve the dashboard.)

## 1.3.1 — Long-chat compaction (auto + manual)

- Long conversations can no longer overflow the local model's context window.
  When a chat's estimated size passes ~60% of the model's usable context, the
  server condenses the older messages into a short digest locally (Ollama only;
  cloud-bound messages still shrink to the last user turn) and keeps working
  with the newest messages. The visible history in the chat is left intact.
- Chat settings gain **Summarize & compress**: a one-click way to condense the
  earlier part of a conversation with your local model. The older messages are
  replaced by a collapsible "Compacted earlier part of this conversation" note,
  the newest few are kept, and the result is saved to this machine's history.
- The `/api/chat/summarize` endpoint (rate-limited, local-only) runs a
  non-streaming summary through the local model and validates its inputs.
- Fixed a latent `streamOllamaChat` bug where a failing Ollama request could
  throw `tokenCount is not defined` (temporal dead zone in the catch block) and
  mask the real error.
- The encrypted chat store now preserves the `kind` marker on compact-note
  messages so they render correctly after a reload.

## 1.3.0 — Option cards align, "Code" agent mode, chat export

- Agent option cards (Start Agent switch, Autonomy radios, Organize styles)
  no longer fall back to the settings label's stacked `display:block` — they
  keep their icon-left / text-right flex layout again.
- The topbar now fits viewports around 780px (project picker hides, gaps and
  the chat-title input shrink below 880px; the live agent status bar also
  compacts).
- The supervised coding-plan profile (previously an unreachable Agent option)
  returns as a proper third mode: **Code — supervised plan, write, review**.
  Pick it from the terminal mode chip (◈ Code), the Agent dialog segment, or
  `/agent`; the shell badge and voice pill show `CODE`. As a mode it is
  permissioned like Build, so files and commands still pause for approval,
  and guarded chat messages get the dedicated coding profile.
- Chat settings now offers **Export Markdown** (render the current chat to a
  `.md` file), **Backup JSON** (all chats + projects in one portable file),
  and **Restore…** (import a JSON backup, merging chats and projects and
  keeping anything already present). Backups are plain files that leave only
  your machine; Restore is hidden when reached through a shared Remote link.

## 1.2.3 — Bigger dialogs everywhere, shared switch

- All dialogs (Deep Research, Fit, Changes, Model Cockpit, Chat settings,
  Skills, Norms, Cloud, Vault, Remote, Model Library, installer) now open up
  to 720px wide (Agent / Research / Model Library up to 820px) and scroll
  internally instead of filling the page.
- The Deep Research popup width now applies to the dialog itself (it was only
  sizing an inner element, which overflowed the 560px box).
- New shared `.capsule-switch` toggle style; the "Use Agent Mode", "I adopt
  these norms", and cloud "Remember on this computer" checkboxes all render
  as pill switches.

## 1.2.2 — Bigger Agent dialog, toggle switch

- The **Agent** popup is wider (up to 820px) and scrolls internally instead of
  filling the page; card labels wrap instead of nudging horizontal scrollbars.
- "Use Agent Mode" is now a proper **toggle switch** (still a checkbox
  underneath, so the existing persistence logic is unchanged); the option card
  highlights while the mode is on.

## 1.2.1 — Fit model suggestion

- **Automatic model suggestion**: before any model has been chosen, the chat
  selector opens on the Fit-best **installed** model (rather than the first one
  in the list). Changing the **Fit level** re-selects the best installed model
  for that level — until you pick one yourself, which is always respected.
- **Fit card actions**: the suggested curated model now has a **Use this model**
  button when it is already installed, and an **Install (~N GB)** button when it
  is not — the latter opens the Model Library and starts the download there.
- `/api/fit*` now also reports `top_installed_model` (name, size, predicted
  tokens/second, interactivity) plus whether the curated suggestion is already
  installed, using the same `recommendFit` engine against the live Ollama model
  list.

## 1.2.0 — Fit and undo

### Undo everything
- **Change ledger + global undo**: every write, folder organization, image generation, and saved research report is recorded as you go. A **Changes** card lists each one with its own **Undo** button — restore any change, in any order, not just the most recent (and not just the agent's last write).
- Oversized existing-file rewrites skip the ledger snapshot; image/research records persist even after the download model is unloaded.

### Fit engine
- **Fit** measures this computer once with a pure-JS benchmark (reference = the i5-3570 build machine ≈ 1.0×), then maps one **level** (Frugal/Balanced/Max) to coherent defaults: suggested curated model, image size + hires, voice engine, and image CPU threads.
- **Self-correcting estimates**: real chat streams and image jobs are measured (tokens/second, minutes/megapixel) and blended into future predictions via the Fit dialog.
- Minimal, honest `/api/fit*` endpoints, cached benchmark, per-level persistence in `fit-state.json`.
- Cross-platform SIMD detection: Linux `/proc/cpuinfo`, macOS `sysctl`, and an optional Windows `cpuid.exe` helper (`tools/cpuid.c`, `tools/build-cpuid.ps1`) with a conservative `baseline` fallback when absent.

## 1.1.0 — Local AI on your terms

### Image Generation
- First-class **Image** tab: generate images fully locally with stable-diffusion.cpp (CPU-only, no GPU, no API key).
- Curated default preset — Realistic Vision v6 Q8_0, euler_a · karras, 24 steps, CFG 7, with a two-pass high-res refinement baked in.
- Honest time estimates before you wait ("~8 min on this computer"), a launcher note explaining the one-time ~1.8 GB model download, and a status chip that reports the installed engine + model.
- Attach an image to any chat message inline.

### Agent experience
- Slash-command surface slimmed from 25 to 15: `/help /status /norms /run /write /undo /research /mcp /skills /forget /model /agent /new /stop /clear`.
- Start screen reorganized into 8 cards: *Start a task · Ask my files · Text tools · Organize my files · Deep research · Choose a skill · Check readiness · Our Norms*.
- Four separate text cards merged into one **Text tools** card with a draft / summarize / polish / translate picker.
- `/help` groups rewritten to match the new command set; the workspace line merged into `/status`.
- Voice Mode's chat brain now drives the real send button instead of a hidden `/ask` route.
- Fixed a pre-existing startup crash (agent preview read the long-removed `#agent-code` checkbox).

### Portable capsule + integrity
- Portable runtimes ship alongside the app (Linux x64 packaged, other platforms fetched on demand).
- **Capsule integrity**: a signed manifest fingerprints every guarded release file; boots fail closed on tamper and can repair from the bundle.
- Hardware probe publishes CPU/RAM/disk/AVX/GPU so the app can size itself to modest machines.
- Offline restore and signed manifest verification at first start.

### Deep Research
- **Deep research** flow with quick / deep passes, cited sources, pause/resume, and Markdown export; runs locally via the agent's search tools.

### Cloud link
- **Capsule Remote**: connect to this machine over a private HTTPS link from anywhere (Cloudflare quick tunnel or Tailscale), with QR pairing and one-line status emissions.

### Voice
- Live voice mode with browser-native speech; now local-only: offline kokoro TTS worker, optional piper corpus, Voice-only mode using just the microphone.
- Spoken approvals for agent actions.

### Tools & quality
- `npm run lint` (`tools/lint.mjs`) checks every Node file plus inline HTML scripts; wired into a versioned pre-commit hook that also refreshes the signed manifest automatically.
- Plain-language UI copy throughout ("Made on this computer — your images never leave it.").
- 69 automated tests across image generation, hardware probe, voice, vault, integrity, and user session flows.

---

## 1.0.0 — Baseline

Initial release: local chat with an OpenAI-compatible endpoint, agent mode with supervised autonomy (Plan/Build toggle, Our Norms, undo, undo-stack), browser-native voice mode, secure user vault, and a portable USB-kit layout.