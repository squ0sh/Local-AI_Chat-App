# Release tree audit — before cleanup

Baseline: main `aef3c4e`, published v1.15.0-x64. Inspected the local matching
ZIPs in `/home/squ0sh/Work/Local-AI_Chat-App/dist` before packaging changes.

## Current layout and cause

Each ZIP has a `Capsule/` root containing 116 signed source files, the manifest,
and a single platform's runtime subtree. The builder takes every path from the
source integrity manifest, then appends runtime files. The integrity inventory
recursively includes tests, tools, cloud deployment files and Git hooks.
Therefore foreign launchers and developer files are deliberately enumerated
by the old inventory, not accidentally copied from runtime caches.

```text
Capsule/
  .githooks/ .gitignore                 developer state/configuration
  README.md FRIENDS-AND-FAMILY.md SECURITY.md
  DISTRIBUTION-READINESS-REPORT.md FINAL-STABILIZATION-REPORT.md
  Local AI Chat.command                macOS Finder launcher
  Local AI Chat.desktop                Linux desktop entry
  start-portable.cmd                   Windows launcher
  start-portable.sh                    shared Linux/macOS bootstrap
  server.mjs index.html capsule-ui.js capsule.json skills.json package.json
  capsule-integrity.json capsule-signing-pub.pem
  assets/ lib/                         shared application
  cloud/                               runtime pins AND deployment sources
  models/README.txt                    user documentation, no models
  runtime/{index.json,downloads.txt,README.md,licenses/}
  runtime/platforms/<one target>/       Node, Ollama, libraries/licenses
  test/                                developer tests and fixtures
  tools/                               mixed runtime, user and build helpers
```

## Classification and retention decisions

| Category | Files | Decision |
| --- | --- | --- |
| Shared runtime | server, UI, configuration, assets, application lib modules | Keep paths stable |
| Verification | public PEM, signed manifest, integrity module, verify-release helper | Keep; public key is intentionally distributable |
| Runtime recovery | downloads table, runtime index, runtime-pins, bootstrap helpers | Keep required helpers and strict hash checks |
| Platform launchers | cmd, command, desktop, shared Unix shell | Select per platform; shell is required by macOS command |
| User utilities | model CLI, backup, matching service script, Linux menu registration | Retain platform-relevant utilities |
| Cloud | cloudflared-manifest.json versus worker/wrangler/README | Keep runtime download pins; deployment sources stay in repository |
| Tests/build | test/, Git hooks, signing/build/lint/UI-probe tools, CPUID source | Retain in repository, omit from user ZIPs |
| Documentation | friend/security/licensing/runtime guidance versus engineering reports | Keep useful shared user docs; omit engineering reports from ZIPs |
| Local generated state | dist/, runtime/platforms/, .portable/ | Ignored; do not delete user models, chats, caches or existing releases |

Do not move the app into a new app/ hierarchy: existing launch, repair, USB copy
and module-resolution paths depend on the current layout. A small START HERE
document and platform-only entry points are safer than relocating the app.

## Initial Linux findings

The source desktop file and Unix launchers are executable. The builder retains
executable bits in ZIP Unix attributes. The desktop Exec uses `%k` rather than a
fixed extraction path, but its shell quoting uses single backslash escaping
where the desktop specification requires two parsing layers. `%k` may also be
a URI, which the current dirname expression cannot handle. Desktop trust and
noexec mounts are separate issues; archive executable bits cannot grant trust.
These are findings to reproduce, not a claim that one caused the user's failure.

Specification: https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html

## Initial secret check

The actual project's available refs/reflogs were non-shallow. A preliminary
scan of 477 blobs up to 10 MB found no complete private PEM blocks or recognizable
GitHub/AWS/OpenAI tokens. This is preliminary only: follow-up must cover tags,
all available object sizes, embedded manifest repair data and local/archive files.
