# Changelog

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