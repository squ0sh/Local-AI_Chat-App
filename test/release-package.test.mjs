import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checksumLine, releaseFiles, safeReleasePath, signChecksums, verifyChecksums } from '../lib/release-package.mjs';
import { pubkeyFingerprint, releaseStatus } from '../lib/capsule-integrity.mjs';

test('release file selection rejects secret paths and only includes the selected platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-release-test-'));
  try {
    mkdirSync(join(root, 'runtime/platforms/linux-x64/node/bin'), { recursive: true });
    writeFileSync(join(root, 'runtime/platforms/linux-x64/node/bin/node'), 'binary');
    writeFileSync(join(root, 'README.md'), 'docs');
    writeFileSync(join(root, 'capsule-integrity.json'), '{}');
    assert.deepEqual(releaseFiles(root, { files: [{ path: 'README.md' }] }, 'linux-x64'), [
      'README.md', 'capsule-integrity.json', 'runtime/platforms/linux-x64/node/bin/node',
    ]);
    for (const path of ['.portable/data/chat.json', '.env', 'data/keys', 'node_modules/a', '../secret', 'signing/key.pem']) {
      assert.equal(safeReleasePath(path), false, path);
      assert.throws(() => releaseFiles(root, { files: [{ path }] }, 'linux-x64'), /unsafe/);
    }
    assert.throws(() => releaseFiles(root, { files: [] }, 'linux-x64'), /unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detached checksum signature binds archive bytes to the known release key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const line = checksumLine('Capsule-v1.2.3-linux-x64.zip', Buffer.from('archive'));
  const signature = signChecksums(line, priv, pub);
  assert.equal(verifyChecksums(line, signature, pub), true);
  assert.equal(verifyChecksums(line.replace('a', 'b'), signature, pub), false);
  assert.match(pubkeyFingerprint(pub), /^[a-f0-9]{64}$/);
});

test('release status distinguishes verified, development, and failed states', () => {
  assert.equal(releaseStatus({ verified: true, signed: true }, { devMode: false }).state, 'verified');
  assert.equal(releaseStatus({ verified: true, signed: false }, { devMode: true }).state, 'development');
  assert.equal(releaseStatus({ verified: false, signed: true }, { devMode: false }).state, 'failed');
});
