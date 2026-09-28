import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import { buildReleaseManifest, capsuleTrustFromEnv, integrityCheck, repairReleaseFiles, rebuildManifest, releaseTrackedPaths } from '../lib/capsule-integrity.mjs';

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function stageTree(root) {
  for (const path of releaseTrackedPaths(root)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'staged placeholder ' + path + '\n');
  }
}

const appDir = join(dirname(new URL('../lib/capsule-integrity.mjs', import.meta.url).pathname), '..');

test('buildReleaseManifest embeds a restorable canonical copy for every tracked file', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-build-'));
  try {
    stageTree(root);
    const manifest = buildReleaseManifest(root, { embedContent: true });
    assert.ok(manifest.files.length >= 25);
    for (const entry of manifest.files.slice(0, 3)) {
      const buf = gunzipSync(Buffer.from(entry.content, 'base64'));
      assert.equal(buf.length, entry.bytes);
      assert.equal(sha(buf), entry.sha256);
    }
    const plain = buildReleaseManifest(root, { embedContent: false });
    assert.ok(plain.files.every((entry) => !('content' in entry)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rebuildManifest regenerates a missing manifest from the files on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-rebuild-'));
  try {
    stageTree(root);
    const rebuilt = rebuildManifest(root);
    assert.ok(existsSync(join(root, 'capsule-integrity.json')));
    assert.ok(rebuilt.files >= 25);
    const parsed = JSON.parse(readFileSync(join(root, 'capsule-integrity.json'), 'utf8'));
    assert.ok(parsed.files.every((entry) => typeof entry.content === 'string'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repairReleaseFiles restores a missing tracked file byte-for-byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-repair-'));
  try {
    stageTree(root);
    rebuildManifest(root);
    const lost = join(root, 'capsule.json');
    const before = readFileSync(lost);
    rmSync(lost);

    const result = repairReleaseFiles(root, join(root, 'capsule-integrity.json'), { allowUnsigned: true });
    assert.ok(result.restored.includes('capsule.json'));
    assert.deepEqual(Buffer.compare(readFileSync(lost), before), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repairReleaseFiles keeps present-but-different files under policy missing and restores under all', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-policy-'));
  try {
    stageTree(root);
    rebuildManifest(root);
    const manifestFile = join(root, 'capsule-integrity.json');

    const target = join(root, 'skills.json');
    const original = readFileSync(target);
    writeFileSync(target, 'truncated garbage');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const entry = manifest.files.find((f) => f.path === 'skills.json');
    assert.ok(entry);

    const safe = repairReleaseFiles(root, manifestFile, { allowUnsigned: true });
    assert.ok(safe.changed.includes('skills.json'));
    assert.ok(!safe.restored.includes('skills.json'));
    assert.equal(readFileSync(target, 'utf8'), 'truncated garbage');

    const aggressive = repairReleaseFiles(root, manifestFile, { allowUnsigned: true, policy: 'all' });
    assert.ok(aggressive.restored.includes('skills.json'));
    assert.deepEqual(Buffer.compare(readFileSync(target), original), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repairReleaseFiles refuses hostile manifest entries and unknown paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-hostile-'));
  try {
    stageTree(root);
    rebuildManifest(root);
    const manifestFile = join(root, 'capsule-integrity.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.files.push({ path: '../escape.txt', bytes: 4, sha256: sha(Buffer.from('evil')), content: gzipSync(Buffer.from('evil')).toString('base64') });
    manifest.files.push({ path: '/tmp/absolute.txt', bytes: 4, sha256: sha(Buffer.from('evil')), content: gzipSync(Buffer.from('evil')).toString('base64') });
    writeFileSync(manifestFile, JSON.stringify(manifest));

    const result = repairReleaseFiles(root, manifestFile, { allowUnsigned: true });
    assert.ok(result.failed.length > 0);
    assert.equal(existsSync(join(root, '..', 'escape.txt')), false);
    assert.equal(existsSync('/tmp/absolute.txt'), false);

    rebuildManifest(root);
    const unknown = repairReleaseFiles(root, manifestFile, { allowUnsigned: true, path: 'does-not-exist.mjs' });
    assert.ok(unknown.failed.some((f) => f.path === 'does-not-exist.mjs'));

    const targetedEscape = repairReleaseFiles(root, manifestFile, { allowUnsigned: true, path: '../escape.txt', policy: 'all' });
    assert.ok(targetedEscape.failed.some((f) => f.path === '../escape.txt'));
    assert.equal(existsSync(join(root, '..', 'escape.txt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repairReleaseFiles never replaces a missing or corrupt trust manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-no-rebaseline-'));
  try {
    stageTree(root);
    const manifestFile = join(root, 'capsule-integrity.json');
    const missing = repairReleaseFiles(root, manifestFile, { allowUnsigned: true });
    assert.equal(missing.verified, false);
    assert.equal(missing.manifest_rebuilt, false);
    assert.equal(existsSync(manifestFile), false);

    writeFileSync(manifestFile, '{broken json');
    const before = readFileSync(manifestFile, 'utf8');
    const corrupt = repairReleaseFiles(root, manifestFile, { allowUnsigned: true });
    assert.equal(corrupt.verified, false);
    assert.equal(corrupt.manifest_rebuilt, false);
    assert.equal(readFileSync(manifestFile, 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repairReleaseFiles rejects a symlinked parent instead of writing outside the app', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-symlink-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'capsule-symlink-outside-'));
  try {
    stageTree(root);
    rebuildManifest(root);
    rmSync(join(root, 'runtime'), { recursive: true, force: true });
    symlinkSync(outside, join(root, 'runtime'), 'dir');
    const result = repairReleaseFiles(root, join(root, 'capsule-integrity.json'), {
      allowUnsigned: true,
      path: 'runtime/README.md',
      policy: 'all',
    });
    assert.equal(result.restored.length, 0);
    assert.ok(result.failed.some((entry) => /symbolic link/i.test(entry.error)));
    assert.equal(existsSync(join(outside, 'README.md')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('integrityCheck rejects empty, duplicate, and incomplete manifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-coverage-'));
  try {
    stageTree(root);
    const manifestFile = join(root, 'capsule-integrity.json');
    writeFileSync(manifestFile, JSON.stringify({ schema_version: 2, algorithm: 'sha256', files: [] }));
    assert.equal(integrityCheck(root, manifestFile).ok, false);

    rebuildManifest(root);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.files.push({ ...manifest.files[0] });
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const duplicate = integrityCheck(root, manifestFile);
    assert.equal(duplicate.ok, false);
    assert.ok(duplicate.drifted.some((path) => /duplicate/.test(path)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only explicit CAPSULE_DEV_MODE enables unsigned developer manifests', () => {
  assert.deepEqual(capsuleTrustFromEnv({}), {
    devMode: false,
    allowUnsigned: false,
    legacyUnsignedIgnored: false,
  });
  assert.equal(capsuleTrustFromEnv({ CAPSULE_ALLOW_UNSIGNED: '1' }).allowUnsigned, false);
  assert.equal(capsuleTrustFromEnv({ CAPSULE_ALLOW_UNSIGNED: '1' }).legacyUnsignedIgnored, true);
  assert.equal(capsuleTrustFromEnv({ CAPSULE_DEV_MODE: '1' }).allowUnsigned, true);
});

test('integrityCheck reports drift read-only and never modifies files', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-check-'));
  try {
    stageTree(root);
    rebuildManifest(root);
    const manifestFile = join(root, 'capsule-integrity.json');
    const before = readFileSync(manifestFile);

    const clean = integrityCheck(root, manifestFile);
    assert.equal(clean.ok, true);
    assert.deepEqual(clean.drifted, []);
    assert.equal(clean.files, JSON.parse(readFileSync(manifestFile, 'utf8')).files.length);
    assert.equal(clean.signed, false);

    writeFileSync(join(root, 'skills.json'), 'tampered');
    const drift = integrityCheck(root, manifestFile);
    assert.equal(drift.ok, false);
    assert.deepEqual(drift.drifted, ['skills.json']);
    assert.equal(readFileSync(manifestFile).toString(), before.toString());

    rmSync(join(root, 'capsule.json'));
    const gone = integrityCheck(root, manifestFile);
    assert.equal(gone.ok, false);
    assert.ok(gone.drifted.includes('capsule.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integrityCheck flags an unreadable manifest without throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-check-missing-'));
  try {
    stageTree(root);
    const check = integrityCheck(root, join(root, 'capsule-integrity.json'));
    assert.equal(check.ok, false);
    assert.ok(check.error.includes('Cannot read'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repairReleaseFiles on the real release tree is a read-only no-op when nothing is missing', () => {
  const manifestFile = join(appDir, 'capsule-integrity.json');
  if (!existsSync(manifestFile)) return; // planet with a missing manifest; skip
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (Number(manifest.schema_version) !== 2) return; // source tree is awaiting intentional regeneration
  const result = repairReleaseFiles(appDir, manifestFile, { allowUnsigned: capsuleTrustFromEnv().allowUnsigned });
  assert.equal(result.restored.length, 0);
  assert.equal(result.failed.length, 0);
  assert.ok(manifest.files.length >= 25);
});
