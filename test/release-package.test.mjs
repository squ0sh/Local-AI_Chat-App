import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checksumLine, releaseFiles, safeReleasePath, signChecksums, verifyChecksums } from '../lib/release-package.mjs';
import { pubkeyFingerprint, releaseStatus, buildReleaseManifest, canonicalManifest, portableIntegrityReport, repairReleaseFiles } from '../lib/capsule-integrity.mjs';
import { sign } from 'node:crypto';
import { distributionPaths, assertDistributionContents, RELEASE_PLATFORMS } from '../lib/release-layout.mjs';

test('release file selection rejects secret paths and only includes the selected platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-release-test-'));
  try {
    mkdirSync(join(root, 'runtime/platforms/linux-x64/node/bin'), { recursive: true });
    writeFileSync(join(root, 'runtime/platforms/linux-x64/node/bin/node'), 'binary');
    mkdirSync(join(root, 'runtime/platforms/linux-x64/ollama'), { recursive: true });
    writeFileSync(join(root, 'runtime/platforms/linux-x64/ollama/ollama'), 'binary');
    for (const path of distributionPaths('linux-x64')) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), 'fixture');
    }
    writeFileSync(join(root, 'capsule-integrity.json'), '{}');
    const manifest = { files: [...distributionPaths('linux-x64'), 'test/unshipped.test.mjs', 'start-portable.cmd'].map((path) => ({ path })) };
    const files = releaseFiles(root, manifest, 'linux-x64');
    assertDistributionContents(files, 'linux-x64');
    assert.equal(files.includes('test/unshipped.test.mjs'), false);
    assert.equal(files.includes('start-portable.cmd'), false);
    writeFileSync(join(root, 'runtime/platforms/linux-x64/ollama/key.pem'), 'secret');
    assert.throws(() => releaseFiles(root, manifest, 'linux-x64'), /Unsafe/);
    rmSync(join(root, 'runtime/platforms/linux-x64/ollama/key.pem'));
    writeFileSync(join(root, 'runtime/platforms/linux-x64/ollama/innocent.txt'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.throws(() => releaseFiles(root, manifest, 'linux-x64'), /Private signing material/);
    for (const path of ['.portable/data/chat.json', '.env', 'data/keys', 'node_modules/a', '../secret', 'signing/key.pem']) {
      assert.equal(safeReleasePath(path), false, path);
      assert.throws(() => releaseFiles(root, { files: [{ path }] }, 'linux-x64'), /unsafe/);
    }
    assert.throws(() => releaseFiles(root, { files: [] }, 'linux-x64'), /unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const platform of RELEASE_PLATFORMS) test('signed platform inventory, repair and tamper rejection: ' + platform, () => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-profile-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    for (const path of distributionPaths(platform)) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), 'fixture ' + path);
    }
    writeFileSync(join(root, 'capsule-signing-pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
    const manifest = buildReleaseManifest(root, { platform });
    const signIt = () => { manifest.signature = { algorithm: 'ed25519', value: sign(null, Buffer.from(canonicalManifest(manifest)), privateKey).toString('base64') }; };
    const file = join(root, 'capsule-integrity.json');
    const save = () => writeFileSync(file, JSON.stringify(manifest));
    signIt(); save();
    assert.equal(portableIntegrityReport(root, file).verified, true);
    assert.equal(buildReleaseManifest(root).distribution, platform);
    rmSync(join(root, 'skills.json'));
    assert.equal(repairReleaseFiles(root, file).verified, true);
    assert.equal(existsSync(join(root, 'test')), false);
    const paths = [...distributionPaths(platform), 'capsule-integrity.json', ...(
      platform.startsWith('win32') ? ['node/node.exe', 'ollama/ollama.exe'] : ['node/bin/node', 'ollama/ollama']
    ).map((p) => 'runtime/platforms/' + platform + '/' + p)];
    assertDistributionContents(paths, platform);
    for (const forbidden of ['test/a.test.mjs', '.portable/data/chat.json', 'tools/sign-capsule.mjs', '.env', 'key.pem', 'coverage/a', 'node_modules/a', 'runtime/platforms/foreign/node', 'runtime/platforms/' + platform + '/token.txt']) {
      assert.throws(() => assertDistributionContents([...paths, forbidden], platform), /Unexpected/);
    }
    const otherLauncher = platform.startsWith('win32') ? 'Local AI Chat.command' : 'start-portable.cmd';
    assert.throws(() => assertDistributionContents([...paths, otherLauncher], platform), /Unexpected/);
    writeFileSync(join(root, 'skills.json'), 'tampered');
    assert.equal(portableIntegrityReport(root, file).verified, false);
    assert.equal(repairReleaseFiles(root, file).verified, false);
    assert.equal(repairReleaseFiles(root, file, { policy: 'all' }).verified, true);
    const original = manifest.distribution;
    manifest.distribution = platform === 'linux-x64' ? 'darwin-x64' : 'linux-x64'; save();
    assert.equal(portableIntegrityReport(root, file).verified, false);
    manifest.distribution = original; delete manifest.signature; save();
    assert.equal(portableIntegrityReport(root, file).verified, false);
    signIt(); manifest.files.pop(); save();
    assert.equal(portableIntegrityReport(root, file).verified, false);
    assert.ok(readFileSync(join(root, 'skills.json')).length);
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
