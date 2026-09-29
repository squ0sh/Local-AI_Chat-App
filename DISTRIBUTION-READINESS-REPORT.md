# Distribution readiness report

## Scope and result

This document describes the distribution path; FINAL-CLEANUP-REPORT.md records
the current cleanup validation. The app has a per-platform ZIP builder, a signed archive
checksum, an externally documented release-key fingerprint, a visible
verified/development state, and first-run guidance that asks for a model
download decision. The prior signed, self-repairing application manifest
remains the startup gate.

**Release decision:** do not publish an all-platform release until each target
ZIP has been built from its pinned runtime, independently verified, and smoked
on the matching operating system and CPU architecture. Only Linux x64 can be
exercised on this development machine. A signed ZIP is not a code-signing
certificate or an operating-system notarization.

## What ships and what stays private

Each `Capsule-vVERSION-PLATFORM.zip` contains one `Capsule/` directory: the
explicit shared-plus-platform allowlist in lib/release-layout.mjs, its freshly
signed platform-specific manifest (including embedded repair content), and exactly the
named platform runtime. The builder rejects symlinks and unsafe paths and
refuses an unsigned or developer-mode manifest. It checks the bundled Node and
Ollama executables against signed `runtime/downloads.txt` pins. It does not
include `.portable/`, model downloads, chats, environment files, Git history,
or the private release key. Tests, developer/signing tools, Git hooks and foreign
launchers are excluded. The signed canonical manifest binds the distribution
platform; verification still requires complete coverage of that explicit list.
Models are chosen and downloaded by each user. Source files retain their own
complete manifest. Existing application paths stay unchanged for compatibility.

The private Ed25519 key stays only on the controlled release machine. Its
public-key fingerprint (SHA-256 of canonical SPKI DER) is:

```text
c2d5bf55d9d4a1167c15cc64f03b683af6b85d8c770b9cdb5367739390e84ba5
```

The `.sha256` file and detached `.sha256.sig` bind the ZIP bytes to that key.
The `.release.json` file is informational, not independently signed. Startup
then validates the protected application files against the signed manifest.
Runtime support libraries are covered by the pinned source-archive download
when produced through `tools/package-runtimes.mjs`; individual support-library
hashes are not checked at every start. The key fingerprint should also be
distributed through a channel independent of the ZIP when authenticity matters.

## First use and recovery

`README.md` now leads with a short setup path, clear privacy boundaries, and
hardware expectations. `FRIENDS-AND-FAMILY.md` gives plain-language first-run,
download, backup, and recovery steps. The UI identifies verified and
development builds. A first-time user without a model sees a recommendation
and download size, then opens Model library to review requirements and decide
whether to install. The recommendation is a fit estimate, not a performance
guarantee. Damaged protected files stop startup with a recovery path and
technical detail; an unverified build cannot silently look like an official
release. Interrupted model pulls can resume, while storage and engine failures
remain visible rather than silently changing to cloud AI.

## Threat model and limitations

`SECURITY.md` documents archive and manifest trust, private reporting, and
remaining risks. Tampering with a ZIP is detectable when the detached
signature is verified against a previously known key; the UI badge alone does
not establish original ZIP provenance. This design does not protect against a
stolen signing key, compromised release host, compromised OS, malicious model
data, or an attacker who replaces both the ZIP and the only source of the
trusted fingerprint. There is no automatic executable updater. Future update
work must retain signature verification, downgrade protection, offline
operation, and explicit user control before replacing code.

## Safe release procedure

1. Use a clean release checkout and trusted release machine. Confirm the
   expected public-key fingerprint above and that the private key is outside
   the checkout (`CAPSULE_SIGNING_KEY` can specify its path). Never print,
   commit, copy into `dist/`, or upload the private key.
2. Review source changes and dependency/runtime pins. Run `npm run lint`,
   `npm test`, and `npm run integrity`. Then run `npm run integrity:check`.
   Confirm the manifest is signed and there is no unreviewed source drift.
3. Run `npm run runtimes:package` on the controlled machine when needed to obtain and
   verify the pinned runtime archives. Confirm the
   generated download table and source archives against the reviewed pins.
4. For each official target, `linux-x64`, `darwin-x64`, and `win32-x64`, run
   `npm run release:build -- --platform PLATFORM`. The output is under `dist/`:
   ZIP, `.sha256`, `.sha256.sig`, and `.release.json`.
5. For every ZIP, run `node tools/verify-archive.mjs dist/ZIPNAME.zip` from a
   trusted checkout and compare the printed fingerprint. Inspect the ZIP list
   for only one platform runtime and no private files. Extract it into a fresh
   writable directory; launch it and check the sidebar says **Verified
   release**. Test no-model setup, install/resume, chat, restart, and offline
   use on that exact operating system and architecture.
6. Publish only the reviewed ZIPs and matching three sidecars as a GitHub
   release, together with the fingerprint and `FRIENDS-AND-FAMILY.md` link.
   Do not label an untested platform ready. Keep the original signed artifacts
   for reproducible incident review. Never publish `.portable/` or model/chat
   data. Verify the public download again after upload.

## Historical validation record (before final cleanup)

On this Linux x64 development machine, `npm run lint`, `npm test` (229 tests),
and `npm run integrity:check` passed. The first complete Chromium UI probe
passed 79 checks; the final probe adds explicit assertions for the verified
badge and no automatic model download. A Linux x64 ZIP built from the pinned
runtime, passed detached-signature/checksum verification, extracted to a fresh
directory, and passed its embedded startup integrity check (116 protected
files). Its extracted runtime directory contained only `linux-x64`; no private
key or environment file was found. The subsequent published v1.15.0-x64 ZIPs
passed native GitHub Actions startup on Ubuntu, Windows and Intel macOS
(run 36554573163). Those old results do not validate new cleanup ZIPs; consult
FINAL-CLEANUP-REPORT.md for current results. ARM64 is not part of this release.

## Final cleanup release procedure additions

Before signing, run `node tools/audit-secrets.mjs .` and review only redacted
findings. If an actual release key is found in history, stop and rotate the
identity with the owner's approval. Deletion alone cannot repair a leaked key.
The public key intentionally remains at capsule-signing-pub.pem to preserve
existing trust-root references. It is safe and necessary to distribute.

Each ZIP now contains its own START HERE text file. Windows users double-click
start-portable.cmd; Intel Mac users double-click Local AI Chat.command. Capsule
is not Apple-notarized, so Gatekeeper can block first launch. Never disable OS
security or strip quarantine attributes. Linux uses Local AI Chat.desktop
where supported, with explicit Allow Launching/trust approval if required;
the fallback is bash start-portable.sh. noexec drives cannot run bundled code.
Do not claim a headless launcher test validates a human file-manager click.

Build a new version, never overwrite an already trusted release's assets. Test
its public prerelease ZIPs with the read-only native workflow before promotion.
Archive acquisition trust remains necessary: self-verification starts only
after bootstrap and bundled Node code execute. Runtime support libraries are
archive-signed but not individually rehashed at every startup.
