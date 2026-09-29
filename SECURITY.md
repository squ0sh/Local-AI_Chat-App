# Security and release trust

Please report suspected vulnerabilities privately through GitHub's
**Report a vulnerability** option on this repository's Security tab. Include
the affected version, platform, steps to reproduce, expected and observed
behavior, and relevant logs with secrets removed. If private reporting is not
available, open a minimal public issue asking for a private channel without
posting exploit details or personal data.

## Official release identity

The official Ed25519 public key has this SHA-256 fingerprint (canonical SPKI
DER encoding):

```text
c2d5bf55d9d4a1167c15cc64f03b683af6b85d8c770b9cdb5367739390e84ba5
```

This fingerprint lives in the repository as well as release metadata. Keep a
copy independently when checking a future ZIP: replacing only a ZIP cannot
change the previously known fingerprint. GitHub account compromise could
change the repository text; a previously saved fingerprint or another trusted
channel is stronger than checking the current page alone.

Inside Capsule, `capsule-integrity.json` carries file hashes and an Ed25519
signature. Startup checks those hashes and the signature against the shipped
public key. This detects accidental damage and changes to protected app files
after trusted acquisition. A complete replacement of the ZIP can replace the
shipped key too, so archive authenticity requires checking the external
fingerprint and the detached signature over the published SHA-256 checksum.

The release builder creates one ZIP per platform, a `.sha256` checksum file,
a `.sha256.sig` detached Ed25519 signature (base64), and a `.release.json`
metadata file. The private key belongs only on a controlled release machine;
it must never be committed, uploaded, bundled, or generated as a substitute
identity on a consumer computer. `CAPSULE_DEV_MODE=1` is explicit and is
visibly marked as a development build. The obsolete unsigned flag has no
effect.

## Threats and limits

This design addresses corrupt or modified protected files, tampered archives
when their detached signature is independently checked, unofficial copies
masquerading as the known key, unsigned builds being presented as verified,
and future update substitution when updates follow the same trust rule.

It cannot protect against theft of the signing key, compromise of the release
machine or GitHub account, malware already controlling the operating system,
malicious firmware, vulnerabilities in Node/Ollama or other bundled components,
or a malicious model file. Model files are not signed by Capsule. Runtime
archives are fetched from pinned HTTPS URLs and checked against SHA-256 pins;
the launchers verify the runtime executable hash. Third-party support
libraries are not individually rehashed on every start.

No future executable update should be installed or run solely because it came
from a URL. It must verify under the expected release key, reject malformed
metadata and unexpected downgrades, and keep the app usable offline. Capsule
does not currently include an automatic code updater.
