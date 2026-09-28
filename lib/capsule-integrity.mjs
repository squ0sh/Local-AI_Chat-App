import { createHash, createPublicKey, verify } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';

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

function manifestMetadataError(manifest, requireV2 = true) {
  const schema = Number(manifest?.schema_version);
  if (requireV2 ? schema !== 2 : ![1, 2].includes(schema)) return 'Unsupported integrity manifest schema';
  if (manifest?.algorithm !== 'sha256') return 'Unsupported integrity manifest algorithm';
  if (!Array.isArray(manifest?.files) || !manifest.files.length) return 'Integrity manifest has no file entries';
  return '';
}

function manifestEntryError(entry, schemaVersion) {
  if (!entry || !isSafeTrackedPath(String(entry.path || ''))) return 'Invalid manifest path';
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return 'Invalid expected file size';
  if (!/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) return 'Invalid SHA-256 value';
  if (schemaVersion >= 2) {
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) return 'Invalid file mode';
    if (typeof entry.content !== 'string') return 'Embedded repair content is missing';
    const maxEncoded = Math.max(4096, Math.ceil(entry.bytes * 2) + 1024);
    if (entry.content.length > maxEncoded) return 'Embedded repair content exceeds its size bound';
  }
  return '';
}

const CAPSULE_RELEASE_FILES = [
  '.githooks/pre-commit',
  '.gitignore',
  'FINAL-STABILIZATION-REPORT.md',
  'README.md',
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
  'lib/agent-loop.mjs',
  'lib/capsule-integrity.mjs',
  'lib/capsule-vault.mjs',
  'lib/capsule-handshake.mjs',
  'lib/capsule-net.mjs',
  'lib/capsule-memory.mjs',
  'lib/chat-store.mjs',
  'lib/consolidation.mjs',
  'lib/escrow.mjs',
  'lib/fit-engine.mjs',
  'lib/mcp-client.mjs',
  'lib/memory.mjs',
  'lib/rate-limit.mjs',
  'lib/research-engine.mjs',
  'lib/runtime-pins.mjs',
  'lib/telemetry.mjs',
  'lib/user-store.mjs',
  'lib/resumable-ollama-pull.mjs',
  'lib/hardware.mjs',
  'lib/kokoro-worker.mjs',
  'lib/voice.mjs',
  'lib/peer-transport.mjs',
  'lib/vendor/qrcode-generator.mjs',
  'lib/vendor/jsqr-core.cjs',
  'lib/vendor/jsqr.mjs',
  'lib/vendor/sound-modem.cjs',
  'lib/vendor/sound-modem.mjs',
  'tools/model-cli.mjs',
  'tools/capsule-backup.mjs',
  'tools/generate-integrity.mjs',
  'tools/package-runtimes.mjs',
  'tools/write-downloads.mjs',
  'tools/install-portable-runtime.ps1',
  'tools/ollama-health.mjs',
  'tools/sign-capsule.mjs',
  'tools/update-cloudflared-manifest.mjs',
  'tools/register-menu-entry.sh',
  'tools/ui-probes.mjs',
  'tools/service.sh',
  'tools/service.cmd',
  'cloud/worker.mjs',
  'cloud/README.md',
  'cloud/wrangler.toml',
  'cloud/cloudflared-manifest.json',
  'runtime/README.md',
  'runtime/index.json',
  'runtime/downloads.txt',
  'runtime/licenses/NODE-LICENSE',
  'runtime/licenses/OLLAMA-LICENSE',
  'models/README.txt',
];

function filesUnder(appDir, relativeDir) {
  if (!existsSync(join(appDir, relativeDir))) return [];
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(join(appDir, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
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
  const list = [
    ...CAPSULE_RELEASE_FILES,
    ...filesUnder(appDir, 'lib'),
    ...filesUnder(appDir, 'tools'),
    ...filesUnder(appDir, 'cloud'),
    ...filesUnder(appDir, 'test'),
    ...filesUnder(appDir, '.githooks'),
    ...filesUnder(appDir, 'runtime'),
  ];
  return [...new Set(list)].sort();
}

function safeFilePath(appDir, manifestPath) {
  if (!isSafeTrackedPath(manifestPath)) throw new Error('Invalid manifest path');
  const root = realpathSync(appDir);
  const candidate = resolve(root, ...manifestPath.split('/'));
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(root, rel) !== candidate) {
    throw new Error('Manifest path escapes the application directory');
  }
  let cursor = root;
  const parts = manifestPath.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    cursor = join(cursor, parts[i]);
    if (!existsSync(cursor)) continue;
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error('Manifest path contains a symbolic link');
    if (i < parts.length - 1 && !info.isDirectory()) throw new Error('Manifest parent is not a directory');
    const resolved = realpathSync(cursor);
    const resolvedRel = relative(root, resolved);
    if (resolvedRel === '..' || resolvedRel.startsWith('..' + sep)) {
      throw new Error('Manifest path resolves outside the application directory');
    }
  }
  return candidate;
}

/**
 * A canonical, order-independent encoding of everything a signature binds:
 * algorithm, timestamp and every (path, bytes, sha256) triple. The signature
 * value itself is deliberately not part of the canonical form.
 */
export function canonicalManifest(manifest) {
  const schemaVersion = Number(manifest?.schema_version || 1);
  const lines = [
    schemaVersion >= 2 ? 'capsule-integrity-v2' : 'capsule-integrity-v1',
    String(manifest.algorithm || 'sha256'),
    String(manifest.generated_at || ''),
  ];
  const files = (Array.isArray(manifest.files) ? manifest.files : [])
    .slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of files) {
    if (schemaVersion >= 2) {
      const embeddedHash = typeof f.content === 'string' ? sha256Buffer(Buffer.from(f.content, 'utf8')) : '';
      lines.push(`${f.path}\t${f.bytes}\t${f.sha256}\t${Number(f.mode || 0) & 0o777}\t${embeddedHash}`);
    } else {
      lines.push(`${f.path}\t${f.bytes}\t${f.sha256}`);
    }
  }
  return lines.join('\n');
}

export function pubkeyFingerprint(pubkeyPem) {
  const key = createPublicKey(pubkeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

export function capsuleTrustFromEnv(env = process.env) {
  const devMode = String(env?.CAPSULE_DEV_MODE || '') === '1';
  return {
    devMode,
    allowUnsigned: devMode,
    legacyUnsignedIgnored: !devMode && String(env?.CAPSULE_ALLOW_UNSIGNED || '') === '1',
  };
}

/**
 * Verifies the ed25519 signature embedded in a manifest against the pinned
 * release public key (capsule-signing-pub.pem). Returns { ok, error }.
 */
export function verifyManifestSignature(manifest, pubkeyPem) {
  if (!manifest || typeof manifest.signature !== 'object') return { ok: false, error: 'Manifest is not signed' };
  const sig = manifest.signature;
  if (sig.algorithm !== 'ed25519') return { ok: false, error: 'Unsupported signature algorithm: ' + sig.algorithm };
  let fingerprint;
  try { fingerprint = pubkeyFingerprint(pubkeyPem); }
  catch (error) { return { ok: false, error: 'Invalid pinned public key: ' + error.message }; }
  if (sig.pubkey_sha256 && String(sig.pubkey_sha256) !== fingerprint) {
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
 * { allowUnsigned: true } permits a hash-only manifest for an explicitly
 * selected developer copy; a *present-but-failed* signature is never accepted.
 */
export function portableIntegrityReport(appDir, manifestFile, options = {}) {
  let manifest;
  try {
    if (statSync(manifestFile).size > 50_000_000) throw new Error('manifest exceeds the 50 MB limit');
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  }
  catch (error) { return { verified: false, error: 'Integrity manifest is unavailable: ' + error.message, files: [] }; }

  const allEntries = Array.isArray(manifest.files) ? manifest.files : [];
  const tracked = new Set(releaseTrackedPaths(appDir));
  const requireComplete = options.requireComplete !== false;
  const seen = new Set();
  const structureErrors = new Map();
  const metadataError = manifestMetadataError(manifest, requireComplete);
  if (metadataError) structureErrors.set('<manifest>', metadataError);
  for (const entry of allEntries) {
    const path = String(entry?.path || '');
    const entryError = manifestEntryError(entry, Number(manifest.schema_version));
    if (entryError) structureErrors.set(path || '<invalid manifest entry>', entryError);
    else if (seen.has(path)) structureErrors.set(path, 'Duplicate manifest path');
    else if (requireComplete && !tracked.has(path)) structureErrors.set(path, 'Not a tracked release file');
    seen.add(path);
  }
  if (requireComplete) {
    for (const path of tracked) {
      if (!seen.has(path)) structureErrors.set(path, 'Tracked release file is absent from the manifest');
    }
  }
  const entries = options.platform
    ? allEntries.filter((entry) => !String(entry.path || '').startsWith('runtime/platforms/') || String(entry.path || '').startsWith(`runtime/platforms/${options.platform}/`))
    : allEntries;
  const files = entries.map((entry) => {
    const path = String(entry.path || '');
    if (structureErrors.has(path)) return { path, ok: false, error: structureErrors.get(path) };
    try {
      const file = safeFilePath(appDir, path);
      const bytes = statSync(file).size;
      const actual = sha256File(file);
      return { path, ok: actual === entry.sha256 && bytes === entry.bytes, bytes, expected_bytes: entry.bytes, actual, expected: entry.sha256 };
    } catch (error) { return { path, ok: false, error: error.message }; }
  });
  for (const [path, error] of structureErrors) {
    if (!files.some((file) => file.path === path)) files.push({ path, ok: false, error });
  }
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
      : { ok: false, error: 'Manifest is unsigned; signed release mode requires a valid release signature' };
  }

  return {
    verified: filesOk && signatureState.ok,
    signed: !!manifest.signature,
    signature_error: signatureState.ok ? '' : signatureState.error,
    generated_at: manifest.generated_at || '',
    files,
  };
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
    const file = safeFilePath(appDir, path);
    const bytes = readFileSync(file);
    const entry = { path, bytes: bytes.length, sha256: sha256Buffer(bytes) };
    if (embed) {
      entry.mode = statSync(file).mode & 0o777;
      entry.content = gzipSync(bytes).toString('base64');
    }
    return entry;
  });
  return { schema_version: 2, algorithm: 'sha256', generated_at: new Date().toISOString(), files };
}

function restoredMode(entry) {
  if (Number(entry?.schema_version || 0) < 2) return entry?.path === 'start-portable.sh' ? 0o755 : 0o644;
  return Number(entry?.mode || 0) & 0o111 ? 0o755 : 0o644;
}

/**
 * Rebuilds an unsigned developer manifest from the files currently on disk
 * (embedded canonical copies included) and writes it atomically. Runtime code
 * never discovers or opens the private release key; explicit release tooling
 * is the only signing path.
 */
export function rebuildManifest(appDir, options = {}) {
  const manifest = buildReleaseManifest(appDir, { embedContent: true });
  manifest.generated_at = new Date().toISOString();
  const signing = { signed: false, signature_error: 'Developer regeneration is unsigned; use the explicit release signing command' };
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
    if (statSync(manifestFile).size > 50_000_000) throw new Error('manifest exceeds the 50 MB limit');
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const metadataError = manifestMetadataError(manifest, true);
    if (metadataError) throw new Error(metadataError);
  } catch (error) {
    return { ok: false, error: 'Cannot read ' + manifestFile + ': ' + error.message, drifted: [], files: 0, signed: false };
  }
  const drifted = [];
  if (![1, 2].includes(Number(manifest.schema_version))) drifted.push('<unsupported manifest schema>');
  if (manifest.algorithm !== 'sha256') drifted.push('<unsupported manifest algorithm>');
  const tracked = new Set(releaseTrackedPaths(appDir));
  const seen = new Set();
  for (const entry of manifest.files || []) {
    if (!entry || !isSafeTrackedPath(entry.path)) {
      drifted.push(entry && entry.path ? entry.path : '<invalid manifest entry>');
      continue;
    }
    if (seen.has(entry.path)) {
      drifted.push(entry.path + ' (duplicate)');
      continue;
    }
    seen.add(entry.path);
    if (!tracked.has(entry.path)) {
      drifted.push(entry.path + ' (untracked)');
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(safeFilePath(appDir, entry.path));
    } catch {
      drifted.push(entry.path);
      continue;
    }
    if (sha256Buffer(bytes) !== entry.sha256) drifted.push(entry.path);
  }
  for (const path of tracked) {
    if (!seen.has(path)) drifted.push(path + ' (absent from manifest)');
  }
  return { ok: drifted.length === 0 && seen.size > 0, drifted: [...new Set(drifted)].sort(), files: seen.size, signed: Boolean(manifest.signature) };
}

/**
 * Self-healing core. Restores missing (or, with policy 'all', any
 * non-matching) tracked release files from the canonical copies embedded in
 * the manifest, verifying the decompressed bytes against the pinned hash
 * before accepting them. Never touches paths outside the tracked set, never
 * touches user data, and refuses to restore from a manifest whose signature
 * the pinned key does not validate (unsigned is honoured only under
 * explicit developer mode like the read report).
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
  try {
    if (statSync(manifestFile).size > 50_000_000) throw new Error('manifest exceeds the 50 MB limit');
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const metadataError = manifestMetadataError(manifest, true);
    if (metadataError) throw new Error(metadataError);
    for (const entry of manifest.files) {
      const entryError = manifestEntryError(entry, Number(manifest.schema_version));
      if (entryError) throw new Error((entry?.path || '<entry>') + ': ' + entryError);
    }
  }
  catch (error) {
    result.signature_error = 'Integrity manifest is unavailable: ' + error.message;
    result.failed.push({ path: 'capsule-integrity.json', error: result.signature_error });
    result.files = [];
    return result;
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
    result.signature_error = 'Manifest is unsigned; signed release mode requires a valid release signature';
  }

  const tracked = new Set(releaseTrackedPaths(appDir));

  for (const entry of entries) {
    const path = String(entry.path || '');
    if (!path) continue;
    if (wantedPath && path !== wantedPath) continue;
    if (!isSafeTrackedPath(path) || !tracked.has(path)) {
      result.failed.push({ path, error: 'Not a tracked release file' });
      continue;
    }
    if (path.startsWith('runtime/platforms/')) {
      result.not_restorable.push(path);
      continue;
    }

    let existing = null;
    try {
      const file = safeFilePath(appDir, path);
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
      const compressed = Buffer.from(String(entry.content), 'base64');
      const expectedBytes = Number(entry.bytes);
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error('Invalid expected file size');
      const buf = gunzipSync(compressed, { maxOutputLength: expectedBytes + 1 });
      if (buf.length !== entry.bytes || sha256Buffer(buf) !== entry.sha256) {
        throw new Error('Embedded copy does not match the pinned hash');
      }
      const file = safeFilePath(appDir, path);
      mkdirSync(dirname(file), { recursive: true });
      safeFilePath(appDir, path);
      writeFileSync(file + '.tmp', buf);
      chmodSync(file + '.tmp', restoredMode({ ...entry, schema_version: manifest.schema_version }));
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
