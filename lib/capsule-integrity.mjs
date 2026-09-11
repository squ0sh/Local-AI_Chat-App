import { createHash, createPublicKey, verify } from 'crypto';
import { readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * A canonical, order-independent encoding of everything a signature binds:
 * algorithm, timestamp and every (path, bytes, sha256) triple. The signature
 * value itself is deliberately not part of the canonical form.
 */
export function canonicalManifest(manifest) {
  const lines = ['capsule-integrity-v1', String(manifest.algorithm || 'sha256'), String(manifest.generated_at || '')];
  const files = (Array.isArray(manifest.files) ? manifest.files : [])
    .slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of files) lines.push(`${f.path}\t${f.bytes}\t${f.sha256}`);
  return lines.join('\n');
}

export function pubkeyFingerprint(pubkeyPem) {
  return createHash('sha256').update(String(pubkeyPem)).digest('hex');
}

/**
 * Verifies the ed25519 signature embedded in a manifest against the pinned
 * release public key (capsule-signing-pub.pem). Returns { ok, error }.
 */
export function verifyManifestSignature(manifest, pubkeyPem) {
  if (!manifest || typeof manifest.signature !== 'object') return { ok: false, error: 'Manifest is not signed' };
  const sig = manifest.signature;
  if (sig.algorithm !== 'ed25519') return { ok: false, error: 'Unsupported signature algorithm: ' + sig.algorithm };
  if (sig.pubkey_sha256 && String(sig.pubkey_sha256) !== pubkeyFingerprint(pubkeyPem)) {
    return { ok: false, error: 'Signature was made with a different key than the pinned capsule-signing-pub.pem' };
  }
  let value, key;
  try { value = Buffer.from(String(sig.value || ''), 'base64'); } catch { return { ok: false, error: 'Malformed signature value' }; }
  try { key = createPublicKey(pubkeyPem); } catch (error) { return { ok: false, error: 'Invalid pinned public key: ' + error.message }; }
  let valid;
  try { valid = verify(null, Buffer.from(canonicalManifest(manifest), 'utf8'), key, value); }
  catch (error) { return { ok: false, error: 'Signature check failed: ' + error.message }; }
  return valid ? { ok: true } : { ok: false, error: 'Manifest signature is invalid' };
}

export function signerPublicKeyPath(appDir) {
  return join(appDir, 'capsule-signing-pub.pem');
}

/**
 * Verifies a release manifest without accepting paths outside the app folder.
 * The manifest must be signed with the pinned release key (ed25519), so the
 * hash list itself cannot be swapped by an attacker. Passing
 * { allowUnsigned: true } (CAPSULE_ALLOW_UNSIGNED=1) permits a hash-only
 * manifest for dev copies; a *present-but-failed* signature is never accepted.
 */
export function portableIntegrityReport(appDir, manifestFile, options = {}) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); }
  catch (error) { return { verified: false, error: 'Integrity manifest is unavailable: ' + error.message, files: [] }; }

  const allEntries = Array.isArray(manifest.files) ? manifest.files : [];
  const entries = options.platform
    ? allEntries.filter((entry) => !String(entry.path || '').startsWith('runtime/platforms/') || String(entry.path || '').startsWith(`runtime/platforms/${options.platform}/`))
    : allEntries;
  const files = entries.map((entry) => {
    const path = String(entry.path || '');
    if (!path || path.includes('..') || path.startsWith('/') || path.includes('\\')) {
      return { path, ok: false, error: 'Invalid manifest path' };
    }
    try {
      const file = join(appDir, path);
      const bytes = statSync(file).size;
      const actual = sha256File(file);
      return { path, ok: actual === entry.sha256 && bytes === entry.bytes, bytes, expected_bytes: entry.bytes, actual, expected: entry.sha256 };
    } catch (error) { return { path, ok: false, error: error.message }; }
  });
  const filesOk = files.length > 0 && files.every((file) => file.ok);

  const pubkeyFile = signerPublicKeyPath(appDir);
  let signatureState;
  if (manifest.signature && !existsSync(pubkeyFile)) {
    signatureState = { ok: false, error: 'Manifest is signed but the pinned capsule-signing-pub.pem is missing' };
  } else if (manifest.signature) {
    let pem;
    try { pem = readFileSync(pubkeyFile, 'utf8'); }
    catch (error) { signatureState = { ok: false, error: 'Could not read pinned public key: ' + error.message }; }
    if (!signatureState) signatureState = verifyManifestSignature(manifest, pem);
  } else {
    signatureState = options.allowUnsigned
      ? { ok: true, unsigned: true }
      : { ok: false, error: 'Manifest is unsigned and CAPSULE_ALLOW_UNSIGNED is not set' };
  }

  return {
    verified: filesOk && signatureState.ok,
    signed: !!manifest.signature,
    signature_error: signatureState.ok ? '' : signatureState.error,
    generated_at: manifest.generated_at || '',
    files,
  };
}
