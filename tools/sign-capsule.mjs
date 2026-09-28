import { createPrivateKey, sign } from 'crypto';
import { readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { canonicalManifest, integrityCheck, pubkeyFingerprint, verifyManifestSignature } from '../lib/capsule-integrity.mjs';

// Re-signs the existing capsule-integrity.json without re-hashing files.
// Signs with ~/.capsule-signing/key.pem (or $CAPSULE_SIGNING_KEY) and binds
// to the committed capsule-signing-pub.pem.
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(appDir, 'capsule-integrity.json');
const keyPath = process.env.CAPSULE_SIGNING_KEY || join(homedir(), '.capsule-signing', 'key.pem');
const pubPath = join(appDir, 'capsule-signing-pub.pem');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (Number(manifest.schema_version) !== 2) {
  throw new Error('Refusing to sign an older manifest schema. Run npm run integrity to rebuild schema v2 first.');
}
const coverage = integrityCheck(appDir, manifestPath);
if (!coverage.ok) {
  throw new Error('Refusing to sign a stale or incomplete manifest: ' + (coverage.drifted.join(', ') || coverage.error || 'integrity check failed'));
}
delete manifest.signature;
const key = createPrivateKey({ key: readFileSync(keyPath, 'utf8'), format: 'pem' });
const pub = readFileSync(pubPath, 'utf8');
manifest.signature = {
  algorithm: 'ed25519',
  pubkey_sha256: pubkeyFingerprint(pub),
  value: sign(null, Buffer.from(canonicalManifest(manifest), 'utf8'), key).toString('base64'),
};

const check = verifyManifestSignature(manifest, pub);
if (!check.ok) throw new Error('Self-check failed: ' + check.error);
writeFileSync(manifestPath + '.tmp', JSON.stringify(manifest, null, 2) + '\n');
renameSync(manifestPath + '.tmp', manifestPath);
console.log('Signed ' + manifestPath + ' with ' + keyPath);
console.log('Fingerprint: ' + manifest.signature.pubkey_sha256.slice(0, 24) + '…');
