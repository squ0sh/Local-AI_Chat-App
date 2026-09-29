# Capsule final conservative cleanup

Date: 2026-09-29. Baseline: main aef3c4e / v1.15.0-x64.
Cleanup: v1.15.1, reviewed in [PR #10](https://github.com/squ0sh/Local-AI_Chat-App/pull/10). No AI capabilities or UI redesign added.
Authoritative user checkout: /home/squ0sh/Work/Local-AI_Chat-App.
Changes were prepared in the separate clean release checkout; the older dirty
Work/Codex project was not reset, cleaned, or overwritten.

## Audit before modification

RELEASE-TREE-AUDIT.md records the original ZIP layout and file classifications.
The old builder packaged the entire 116-file source integrity inventory, which
included tests, Git hooks, every launcher and developer tools. Runtime trees
were already restricted to one platform; this was an inventory-boundary error,
not mixed runtime downloads.

## Files removed, reorganized and deliberately retained

No source files were deleted merely for appearance. No chat/model/user data,
working caches, prior releases or public Git history were deleted. Existing
ignored dist/ and runtime/platforms/ are local outputs, not tracked repository
content. No tracked logs, coverage, IDE metadata, OS junk or model downloads
were found. .gitignore now also covers private-key extensions, common Windows
metadata, editor swap/backup files and temporary integrity manifests.

The following are removed from **new user ZIPs**, not from source:

- test/, .githooks/, .gitignore, engineering reports and developer README;
- build, sign, lint, UI-probe, runtime-packaging, pin-generation and CPUID
  source/build tools;
- cloud worker deployment sources, configuration and deployment README;
- foreign-platform launchers and service/runtime-recovery helpers.

New lib/release-layout.mjs defines shared and per-platform allowlists. Each
ZIP includes only its START HERE text. The main application paths and public
key location remain unchanged to protect module resolution, repair and USB
copy compatibility. The source keeps all platform launchers, tests and build
tools. sign-capsule.mjs is retained because it explicitly signs an existing
validated manifest; generate-integrity.mjs rebuilds the manifest. Neither is
shipped. Platform service helpers, model/backup utilities, runtime licensing
and shared security/friend documentation remain intentionally useful.

## Packaging and verification

The builder verifies signed source, selects an explicit allowlist, verifies
runtime executable pins, creates a fresh per-platform manifest and signs that
exact inventory. The platform identifier is covered by the canonical signature.
The verifier still requires complete expected coverage, valid signatures and
matching file hashes. Embedded repair content cannot resurrect excluded files.
The ZIP checksum is separately Ed25519-signed. Symlinks, unknown distribution
paths and private-key files/complete PEM payloads are rejected by packaging.

| ZIP platform | Protected app files | Total regular files | User launcher |
| --- | ---: | ---: | --- |
| Windows x64 | 56 | 110 | start-portable.cmd |
| macOS Intel x64 | 56 | 59 | Local AI Chat.command |
| Linux x64 | 57 | 105 | Local AI Chat.desktop; start-portable.sh fallback |

Only one runtime/platforms/<target>/ directory exists per ZIP. Mac retains the
shared Unix shell because its Finder launcher calls it; it is not a stray Linux
launcher. Runtime index/download metadata and licensing intentionally describe
multiple targets. No ARM64 artifact is published in this cleanup.

## Signing/key and secret audit

The release identity was not rotated: no actual Capsule private signing key or
seed was found in available Git history or tracked source. The public PEM stays
at capsule-signing-pub.pem, with SPKI SHA-256 fingerprint:

`c2d5bf55d9d4a1167c15cc64f03b683af6b85d8c770b9cdb5367739390e84ba5`

The actual external private key was compared in memory, never printed or
copied into the repository. Directory permissions are 0700; key permissions
are 0600. tools/audit-secrets.mjs reports locations/types only. The audit covers
all locally available Git objects, including unreachable objects, after
fetching all currently advertised branches and tags; the repository is not
shallow. It scans raw binary/text bytes without a size cap, historical embedded
gzip manifest content, recognizable provider tokens and the actual signing
seed in raw/hex/base64/base64url forms. File-name history was also reviewed.

Post-cleanup history/source audit snapshot: 515 blobs, 2,456 embedded repair entries,
145 local files, no findings. Separate original working-copy audit: 480 blobs,
2,261 embedded entries, 413 local files. One local-only finding was retained:
the ignored .portable/data/bin/cloudflared executable contains a valid EC key
block. It is **not** the Capsule Ed25519 identity and is not in tracked history
or packaged ZIPs. Its SHA-256 matches the reviewed upstream download pin:
53b7a7a5420d188758d24341294acb0d1bca54296548ac05e38811a694ac6134.
Its upstream purpose was not established here; do not treat it as a Capsule
secret or claim that the entire local working folder is key-material-free.
Generic private-key header strings inside Node are parser strings, not complete
key blocks. No secret bytes were included in audit output.

Scope limit: this cannot establish the absence of arbitrary unrecognized
credentials, remotely deleted/unavailable history, inaccessible backups or
secrets outside the inspected repositories. No public history was rewritten.
If actual Capsule signing material is later found in history, stop distribution
and rotate the signing identity; deletion alone is insufficient.

## Linux desktop findings

The original .desktop file was already executable (Git mode 100755), and ZIP
Unix executable attributes were retained. Its Exec quoting nevertheless failed
actual GIO loading locally. Correcting the two desktop parsing layers fixes
that reproducible problem; the optional generated menu entry was hardened for
path quoting too. Local desktop-file-validate and real GIO dispatch passed from
an unrelated working directory with spaces, Unicode, quotes, dollar and percent
characters in the extraction path. The probe uses a harmless marker launcher;
it is not a human file-manager click. Ubuntu 24.04 passed the filename-aware
GIO DesktopAppInfo.new_from_filename API test too, including generated menu
entries. Its older `gio launch` CLI instead loads a keyfile without preserving
the filename, so `%k` becomes empty. The first CI attempt exposed this test-tool
limitation; the probe now uses the correct filename-aware API rather than
pretending that changing directory or granting trust fixes it. See
[GLib 2.80 launch source](https://github.com/GNOME/glib/blob/2.80.0/gio/gio-tool-launch.c).
The local GIO CLI also passed, but that is not portable to older CLI versions.
URI-only/virtual file-manager locations remain unsupported; extract locally.

Desktop trust cannot be embedded in a ZIP. Users may need executable permission
and Allow Launching/Trust and Launch, depending on the desktop/file manager.
No trust metadata was forced. noexec-mounted media cannot execute bundled
binaries. Menu entries use the current absolute path and must be re-registered
after moving the folder; the portable entry uses its own location.

## Tests and actual platform results

- Full regression/security suite: 235 passed, zero failed/skipped.
- Existing Chromium UI probe: 81 passed, zero failed.
- Syntax lint: 89 JavaScript files plus HTML inline scripts passed.
- Source integrity: 122 protected files, valid release signature.
- New release inventory/security cases cover all six builder profiles, exact
  required files, foreign launchers/runtimes, private state, keys, repair,
  unsigned/tampered/incomplete manifests and signed profile substitution.
- Builder negative experiments reject wrong runtime executable hashes and
  CAPSULE_DEV_MODE before creating an archive.
- Exact-ZIP native checks verify detached signature/checksum, inventory, private
  PEM absence, executable bits, runtime pins, signed startup, tamper rejection,
  unsigned rejection, obsolete-flag rejection and explicit developer mode.
- Windows, Intel macOS and Ubuntu passed downloaded-ZIP checks in
  [run 36613001822](https://github.com/squ0sh/Local-AI_Chat-App/actions/runs/36613001822).
  Windows invoked the same .cmd a friend double-clicks, from outside a path
  containing spaces. macOS exercised Local AI Chat.command via bash, as headless
  CI permits. All three started bundled Ollama and served the verified API and
  HTML. Linux exercised the shell startup plus actual GIO desktop/menu dispatch
  to a marker shell, not a human desktop click or full engine launch via GIO.

Uploaded ZIP digests match the reviewed local files:

| Platform | SHA-256 |
| --- | --- |
| Linux x64 | 2661ca98ddd6c5d615416274e9a3129eeab2ac71d9e75d238e42503315db7c28 |
| Windows x64 | f709cb01416edc32caaa960c0bd4b043af963fd491d2c93673dd90373886c6a6 |
| Intel macOS | 639344fbca9ce08e0f9b0cd4fb30cfdfddac54c5ad8bcaf590cffa6eaff2295a |

The release is [v1.15.1-x64](https://github.com/squ0sh/Local-AI_Chat-App/releases/tag/v1.15.1-x64),
with three ZIPs and nine verification sidecars. Earlier releases remain intact.
Test-harness diagnostics were improved after the candidate upload; no shipped
app/runtime bytes were changed or replaced during those diagnostic iterations.

Default-browser opening is disabled in headless CI; UI HTTP accessibility is
verified instead. No Explorer/Finder GUI click, quarantined download approval,
SmartScreen interaction or Linux trust prompt was human-tested. Capsule is not
Apple-notarized. Gatekeeper can block downloaded software; documentation does
not ask users to disable it or remove quarantine. No OS security was disabled.
The local isolated-startup probe refused to reuse an already running user
Ollama service; that service was left untouched. Hosted runners test fresh
bundled-engine startup.

## Release-blocking issues remaining:

None identified

## Friends-and-family usability issues remaining:

macOS may require OS approval or be blocked because Capsule is not notarized.
Linux desktop launch/trust behavior depends on the file manager; a documented
shell fallback remains. Managed-device policy can prevent downloaded software.

## Security limitations remaining:

Independently trusted archive acquisition is required: bootstrap/Node execute
before self-verification. A replaced ZIP plus replaced public key cannot prove
its own origin. Model files and the host OS are outside Capsule's trust boundary.
Runtime support libraries are archive-signed but not rehashed individually on
every startup. No scan proves all possible secrets absent; the local upstream
cloudflared EC-key finding and history-scope limitations are documented above.

## Repository status:

Clean tracked repository after cleanup merge and synchronization. Generated
dist/ and runtime/platforms/, plus existing private .portable/ state, remain
ignored and deliberately uncommitted. No public history rewrite or user-data
deletion. The older dirty Work/Codex checkout remains untouched.

## Distribution status:

Ready for the documented x64 friends-and-family distribution: exact downloaded
ZIPs passed on Windows 2025, Intel macOS 15 and Ubuntu 24.04; signatures and
security regressions passed. This does not certify Apple notarization, human
GUI click behavior, every Linux file manager, ARM64, or every model/hardware fit.
