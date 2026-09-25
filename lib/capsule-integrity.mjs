import { createHash, createPrivateKey, createPublicKey, verify, sign } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(readFileSync(file));
}

function isSafeTrackedPath(path) {
  if (!path || typeof path !== 'string' || path.startsWith('/')) return false;
  if (path === '..' || path.startsWith('../') || path.includes('\\')) return false;
  return !path.split('/').includes('..');
}

const CAPSULE_RELEASE_FILES = [
  'server.mjs',
  'index.html',
  'capsule-ui.js',
  'capsule.json',
  'skills.json',
  'start-portable.sh',
  'start-portable.cmd',
  'Local AI Chat.command',
  'Local AI Chat.desktop',
  'assets/icon.svg',
  'package.json',
  'capsule-signing-pub.pem',
  'lib/capsule-integrity.mjs',
  'lib/capsule-vault.mjs',
  'lib/chat-store.mjs',
  'lib/rate-limit.mjs',
  'lib/research-engine.mjs',
  'lib/runtime-pins.mjs',
  'lib/resumable-ollama-pull.mjs',
  'lib/hardware.mjs',
  'lib/kokoro-worker.mjs',
  'lib/voice.mjs',
  'lib/vendor/qrcode-generator.mjs',
  'tools/model-cli.mjs',
  'tools/generate-integrity.mjs',
  'tools/package-runtimes.mjs',
  'tools/write-downloads.mjs',
  'tools/install-portable-runtime.ps1',
  'tools/ollama-health.mjs',
  'tools/sign-capsule.mjs',
  'tools/update-cloudflared-manifest.mjs',
  'tools/register-menu-entry.sh',
  'tools/ui-probes.mjs',
  'cloud/worker.mjs',
  'cloud/wrangler.toml',
  'cloud/cloudflared-manifest.json',
  'runtime/README.md',
  'runtime/index.json',
  'runtime/downloads.txt',
  'runtime/licenses/NODE-LICENSE',
  'runtime/licenses/OLLAMA-LICENSE',
];

function filesUnder(appDir, relativeDir) {
  if (!existsSync(join(appDir, relativeDir))) return [];
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(join(appDir, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path === 'runtime/platforms' || path.startsWith('runtime/.platforms-')) continue;
        visit(path);
      } else found.push(path);
    }
  };
  visit(relativeDir);
  return found.sort();
}

/**
 * Every release file the Capsule self-verifies and can restore. Everything in
 * CAPSULE_RELEASE_FILES plus any non-platform files under runtime/ (binaries
 * in runtime/platforms are pinned by the launcher downloads table instead —
 * they are far too large to embed).
 */
export function releaseTrackedPaths(appDir) {
  const list = [...CAPSULE_RELEASE_FILES, ...filesUnder(appDir, 'runtime')];
  return [...new Set(list)].sort();
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

function defaultSigningKeyPath() {
  return process.env.CAPSULE_SIGNING_KEY || join(homedir(), '.capsule-signing', 'key.pem');
}

/**
 * Snapshots every tracked release file into a fresh manifest. With
 * { embedContent: true } (default) each entry also carries a gzip'd base64
 * canonical copy plus the source file mode, so repairReleaseFiles can rebuild
 * a lost file entirely offline.
 */
export function buildReleaseManifest(appDir, options = {}) {
  const embed = options.embedContent !== false;
  const files = releaseTrackedPaths(appDir).map((path) => {
    const file = join(appDir, path);
    const bytes = readFileSync(file);
    const entry = { path, bytes: bytes.length, sha256: sha256Buffer(bytes) };
    if (embed) {
      entry.mode = statSync(file).mode;
      entry.content = gzipSync(bytes).toString('base64');
    }
    return entry;
  });
  return { schema_version: 1, algorithm: 'sha256', generated_at: new Date().toISOString(), files };
}

function trySignManifest(manifest, appDir, signingKeyPath) {
  const keyPath = signingKeyPath || defaultSigningKeyPath();
  const pubPath = signerPublicKeyPath(appDir);
  const result = { signed: false, signature_error: '' };
  let pem, pub;
  try { pem = readFileSync(keyPath, 'utf8'); }
  catch (error) { result.signature_error = 'No signing key at ' + keyPath + ' (' + error.message + ')'; return result; }
  try { pub = readFileSync(pubPath, 'utf8'); }
  catch (error) { result.signature_error = 'Pinned public key missing at ' + pubPath; return result; }
  try {
    const key = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
    manifest.signature = {
      algorithm: 'ed25519',
      pubkey_sha256: pubkeyFingerprint(pub),
      value: sign(null, Buffer.from(canonicalManifest(manifest), 'utf8'), key).toString('base64'),
    };
    const check = verifyManifestSignature(manifest, pub);
    if (!check.ok) throw new Error(check.error);
    result.signed = true;
  } catch (error) {
    delete manifest.signature;
    result.signature_error = error.message;
  }
  return result;
}

/**
 * Rebuilds the manifest from the files currently on disk (embedded canonical
 * copies included), signing it when the release key is available, and writes
 * it atomically. Used when the manifest itself is missing or corrupt, or when
 * the user chooses to accept the files as they are now.
 */
export function rebuildManifest(appDir, options = {}) {
  const manifest = buildReleaseManifest(appDir, { embedContent: true });
  manifest.generated_at = new Date().toISOString();
  const signing = trySignManifest(manifest, appDir, options.signingKeyPath);
  const file = join(appDir, 'capsule-integrity.json');
  writeFileSync(file + '.tmp', JSON.stringify(manifest, null, 2) + '\n');
  renameSync(file + '.tmp', file);
  return {
    manifest,
    signed: signing.signed,
    signature_error: signing.signature_error,
    files: manifest.files.length,
  };
}

/**
 * Read-only drift check: compares every pinned file on disk with its sha256 in
 * the manifest. Used by `npm run integrity --check` and CI so a divergence is
 * reported with the offending paths instead of a cryptic generic failure.
 *
 * Returns { ok, drifted, error } where ok is false when the manifest cannot be
 * read at all (error set) or when any pinned file is missing or different.
 */
export function integrityCheck(appDir, manifestFile = join(appDir, 'capsule-integrity.json')) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return { ok: false, error: 'Cannot read ' + manifestFile + ': ' + error.message, drifted: [], files: 0, signed: false };
  }
  const drifted = [];
  for (const entry of manifest.files || []) {
    if (!entry || !isSafeTrackedPath(entry.path)) {
      drifted.push(entry && entry.path ? entry.path : '<invalid manifest entry>');
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(join(appDir, entry.path));
    } catch {
      drifted.push(entry.path);
      continue;
    }
    if (sha256Buffer(bytes) !== entry.sha256) drifted.push(entry.path);
  }
  return { ok: drifted.length === 0, drifted, files: manifest.files.length, signed: Boolean(manifest.signature) };
}

/**
 * Self-healing core. Restores missing (or, with policy 'all', any
 * non-matching) tracked release files from the canonical copies embedded in
 * the manifest, verifying the decompressed bytes against the pinned hash
 * before accepting them. Never touches paths outside the tracked set, never
 * touches user data, and refuses to restore from a manifest whose signature
 * the pinned key does not validate (unsigned is honoured only under
 * CAPSULE_ALLOW_UNSIGNED like the read report).
 *
 * Returns { verified, restored, changed, not_restorable, failed,
 * manifest_rebuilt, signature_error, generated_at, files } where files is the
 * post-repair per-entry status list from portableIntegrityReport.
 */
export function repairReleaseFiles(appDir, manifestFile, options = {}) {
  const policy = options.policy === 'all' ? 'all' : 'missing';
  const allowUnsigned = Boolean(options.allowUnsigned);
  const wantedPath = options.path ? String(options.path) : null;
  const result = {
    verified: false,
    restored: [],
    changed: [],
    not_restorable: [],
    failed: [],
    manifest_rebuilt: false,
    signature_error: '',
    generated_at: '',
  };

  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); }
  catch (error) {
    const rebuilt = rebuildManifest(appDir, { signingKeyPath: options.signingKeyPath });
    result.manifest_rebuilt = true;
    result.signature_error = rebuilt.signature_error || '';
    result.generated_at = rebuilt.manifest.generated_at || '';
    manifest = rebuilt.manifest;
  }
  if (!manifest.generated_at) result.generated_at = manifest.generated_at = manifest.generated_at || new Date().toISOString();
  else result.generated_at = manifest.generated_at;

  const entries = Array.isArray(manifest.files) ? manifest.files : [];

  const pubkeyFile = signerPublicKeyPath(appDir);
  let trusted = false;
  if (manifest.signature) {
    if (!existsSync(pubkeyFile)) result.signature_error = 'Manifest is signed but the pinned capsule-signing-pub.pem is missing';
    else {
      let pem;
      try { pem = readFileSync(pubkeyFile, 'utf8'); }
      catch (error) { result.signature_error = 'Could not read pinned public key: ' + error.message; }
      if (!result.signature_error) {
        const check = verifyManifestSignature(manifest, pem);
        if (check.ok) trusted = true;
        else result.signature_error = check.error;
      }
    }
  } else if (allowUnsigned) {
    trusted = true;
  } else {
    result.signature_error = 'Manifest is unsigned and CAPSULE_ALLOW_UNSIGNED is not set';
  }

  const tracked = new Set(releaseTrackedPaths(appDir));

  for (const entry of entries) {
    const path = String(entry.path || '');
    if (!path) continue;
    if (wantedPath && path !== wantedPath) continue;
    if (!wantedPath && !tracked.has(path)) {
      result.failed.push({ path, error: 'Not a tracked release file' });
      continue;
    }
    if (path.startsWith('runtime/platforms/')) {
      result.not_restorable.push(path);
      continue;
    }

    let existing = null;
    try {
      const file = join(appDir, path);
      existing = { bytes: statSync(file).size, sha: sha256File(file) };
    } catch { existing = null; }

    if (existing && existing.bytes === entry.bytes && existing.sha === entry.sha256) continue;

    const isMissing = !existing;
    if (!isMissing && policy !== 'all') { result.changed.push(path); continue; }

    if (!trusted) {
      result.failed.push({ path, error: 'Manifest is not trusted (' + (result.signature_error || 'no signature') + '); cannot restore' });
      continue;
    }
    if (!entry.content) {
      result.not_restorable.push(path);
      continue;
    }
    try {
      const buf = gunzipSync(Buffer.from(String(entry.content), 'base64'));
      if (buf.length !== entry.bytes || sha256Buffer(buf) !== entry.sha256) {
        throw new Error('Embedded copy does not match the pinned hash');
      }
      const file = join(appDir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', buf);
      if (entry.mode) chmodSync(file + '.tmp', Number(entry.mode) & 0o7777);
      renameSync(file + '.tmp', file);
      result.restored.push(path);
    } catch (error) {
      result.failed.push({ path, error: error.message });
    }
  }

  if (wantedPath && !entries.some((entry) => String(entry.path || '') === wantedPath)) {
    result.failed.push({ path: wantedPath, error: 'No such entry in the integrity manifest' });
  }

  result.restored.sort();
  result.changed.sort();
  result.not_restorable.sort();
  result.failed.sort((a, b) => a.path.localeCompare(b.path));

  const after = portableIntegrityReport(appDir, manifestFile, { allowUnsigned });
  result.verified = after.verified;
  result.files = after.files;
  return result;
}