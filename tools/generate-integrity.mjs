import { createPrivateKey, sign } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildReleaseManifest, canonicalManifest, pubkeyFingerprint, verifyManifestSignature } from '../lib/capsule-integrity.mjs';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNING_KEY = process.env.CAPSULE_SIGNING_KEY || join(homedir(), '.capsule-signing', 'key.pem');
const manifestPath = join(appDir, 'capsule-integrity.json');

// The manifest embeds gzip'd canonical copies of every tracked file, so a lost
// or corrupt file can be restored entirely offline (see repairReleaseFiles in
// lib/capsule-integrity.mjs).
const manifest = buildReleaseManifest(appDir, { embedContent: true });

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
  console.log('Integrity manifest is current (' + manifest.files.length + ' files' + (current.signature ? ', signed' : ', unsigned') + ').');
} else {
  manifest.generated_at = new Date().toISOString();
  signManifest();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  if (signed) {
    console.log('Signed integrity manifest with ' + SIGNING_KEY);
  } else {
    console.log('Wrote unsigned integrity manifest (' + manifest.files.length + ' files) — no signing key at ' + SIGNING_KEY + (signError ? ' (' + signError + ')' : '') + '.');
    console.log('  Launch via start-portable.sh (it auto-sets CAPSULE_ALLOW_UNSIGNED=1 on keyless machines), or');
    console.log('  set CAPSULE_ALLOW_UNSIGNED=1 manually after npm run integrity.');
  }
  console.log(`Recorded ${manifest.files.length} Capsule files.`);
}