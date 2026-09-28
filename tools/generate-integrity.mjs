import { createPrivateKey, sign } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildReleaseManifest, canonicalManifest, capsuleTrustFromEnv, integrityCheck, portableIntegrityReport, pubkeyFingerprint, verifyManifestSignature } from '../lib/capsule-integrity.mjs';

const appDir = process.env.CAPSULE_APP_DIR
  ? resolve(process.env.CAPSULE_APP_DIR)
  : join(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNING_KEY = process.env.CAPSULE_SIGNING_KEY || join(homedir(), '.capsule-signing', 'key.pem');
const manifestPath = join(appDir, 'capsule-integrity.json');
const trust = capsuleTrustFromEnv();

// The manifest embeds gzip'd canonical copies of every tracked file, so a lost
// or corrupt file can be restored entirely offline (see repairReleaseFiles in
// lib/capsule-integrity.mjs).
const manifest = buildReleaseManifest(appDir, { embedContent: true });

if (process.argv.includes('--check')) {
  const check = integrityCheck(appDir, manifestPath);
  const verification = check.ok
    ? portableIntegrityReport(appDir, manifestPath, { allowUnsigned: trust.allowUnsigned })
    : { verified: false, signature_error: '' };
  if (check.ok && verification.verified) {
    console.log('Capsule files match the ' + (check.signed ? 'signed release' : 'developer') + ' integrity manifest (' + check.files + ' files).');
    process.exit(0);
  }
  console.error('Capsule integrity check FAILED: ' + (check.error || '') + (check.drifted.length ? '\n  drifted: ' + check.drifted.join(', ') : ''));
  if (verification.signature_error) console.error('  signature: ' + verification.signature_error);
  console.error('Run `npm run integrity` after intentional changes, or restore the drifted files (Portable readiness panel -> Restore).');
  process.exit(1);
}

let current = null;
try { current = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {}

// Regeneration is idempotent: when the tracked files are byte-identical to the
// existing manifest we leave it untouched (including its signature and
// timestamp), so `npm run ci` does not produce a spurious diff.
const contentChanged = !current || JSON.stringify(current.files) !== JSON.stringify(manifest.files);

let signed = false;
let signError = '';
function signManifest() {
  try {
    const pem = readFileSync(SIGNING_KEY, 'utf8');
    const key = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
    const pub = readFileSync(join(appDir, 'capsule-signing-pub.pem'), 'utf8');
    manifest.signature = {
      algorithm: 'ed25519',
      pubkey_sha256: pubkeyFingerprint(pub),
      value: sign(null, Buffer.from(canonicalManifest(manifest), 'utf8'), key).toString('base64'),
    };
    const check = verifyManifestSignature(manifest, pub);
    if (!check.ok) throw new Error('self-check failed: ' + check.error);
    signed = true;
  } catch (error) {
    signError = error.message;
  }
}

if (!contentChanged && current) {
  if (!current.signature && !trust.allowUnsigned) {
    console.error('Refusing an unsigned manifest in release mode. Set CAPSULE_DEV_MODE=1 only for an intentional developer copy.');
    process.exit(1);
  }
  console.log('Integrity manifest is current (' + manifest.files.length + ' files' + (current.signature ? ', signed' : ', unsigned') + ').');
} else {
  manifest.generated_at = new Date().toISOString();
  signManifest();
  if (!signed && !trust.allowUnsigned) {
    console.error('Could not sign the release manifest with ' + SIGNING_KEY + (signError ? ': ' + signError : '.'));
    console.error('No file was changed. Set CAPSULE_DEV_MODE=1 only when deliberately producing an unsigned developer manifest.');
    process.exit(1);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  if (signed) {
    console.log('Signed integrity manifest with ' + SIGNING_KEY);
  } else {
    console.log('Wrote unsigned developer integrity manifest (' + manifest.files.length + ' files) — no signing key at ' + SIGNING_KEY + (signError ? ' (' + signError + ')' : '') + '.');
    console.log('  Keep CAPSULE_DEV_MODE=1 set while running this developer copy.');
  }
  console.log(`Recorded ${manifest.files.length} Capsule files.`);
}
