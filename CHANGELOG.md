# Changelog

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