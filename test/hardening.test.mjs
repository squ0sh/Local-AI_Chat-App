import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sealVault, openVault } from '../lib/capsule-vault.mjs';
import { RateLimiter, TokenBucket } from '../lib/rate-limit.mjs';
import { canonicalManifest, portableIntegrityReport, signerPublicKeyPath, verifyManifestSignature, pubkeyFingerprint } from '../lib/capsule-integrity.mjs';
import { ChatStore } from '../lib/chat-store.mjs';

test('vault v2 round-trips and rejects a wrong passphrase', () => {
  const sealed = sealVault('secret chat history', 'correct horse battery staple');
  assert.equal(sealed.version, 2);
  assert.equal(sealed.kdf.name, 'scrypt');
  assert.equal(sealed.kdf.N, 1 << 15);
  assert.equal(openVault(sealed, 'correct horse battery staple'), 'secret chat history');
  assert.throws(() => openVault(sealed, 'wrong passphrase'));
});

test('older v1 vault blobs still open (Node default scrypt N)', async () => {
  const { createCipheriv, scryptSync } = await import('crypto');
  const salt = Buffer.alloc(16, 7);
  const iv = Buffer.alloc(12, 3);
  const key = scryptSync('v1pass', salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update('legacy', 'utf8'), cipher.final()]);
  const v1 = { version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  assert.equal(openVault(v1, 'v1pass'), 'legacy');
  const sealed = sealVault('fresh', 'v1pass');
  assert.equal(sealed.version, 2);
  assert.equal(openVault(sealed, 'v1pass'), 'fresh');
});

test('rate limiter allows bursts then blocks and reports Retry-After', () => {
  const limiter = new RateLimiter({ globalCapacity: 20, perIpCapacity: 5, rate: 20, windowMs: 60_000 });
  const req = () => ({ headers: {}, socket: { remoteAddress: '203.0.113.7' } });
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.check(req()).allowed, true);
  const blocked = limiter.check(req());
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);
  // A different client still has room: its own per-IP bucket gates it.
  const other = { headers: {}, socket: { remoteAddress: '198.51.100.2' } };
  assert.equal(limiter.check(other).allowed, true);
});

test('token bucket refills over time', async () => {
  const bucket = new TokenBucket({ capacity: 1, rate: 10, windowMs: 60_000 });
  assert.equal(bucket.tryConsume('k').allowed, true);
  assert.equal(bucket.tryConsume('k').allowed, false);
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(bucket.tryConsume('k').allowed, true);
});

test('signed integrity manifest verifies and fails closed on tamper', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const appDir = mkdtempSync(join(tmpdir(), 'capsule-integrity-'));
  try {
    writeFileSync(join(appDir, 'capsule-signing-pub.pem'), pubPem);
    const manifest = {
      schema_version: 1,
      algorithm: 'sha256',
      generated_at: new Date().toISOString(),
      files: [
        { path: 'demo.txt', bytes: 9, sha256: createHash('sha256').update('demo data').digest('hex') },
      ],
    };
    const canonical = Buffer.from(canonicalManifest(manifest), 'utf8');
    const signature = sign(null, canonical, privateKey).toString('base64');
    const manifestFile = join(appDir, 'capsule-integrity.json');
    const check = () => portableIntegrityReport(appDir, manifestFile);
    writeFileSync(manifestFile, JSON.stringify(manifest));
    writeFileSync(join(appDir, 'demo.txt'), 'demo data');
    // Unsigned → refuse.
    assert.equal(check().verified, false);
    assert.match(check().signature_error, /unsigned/i);
    // Signed → pass.
    manifest.signature = { algorithm: 'ed25519', pubkey_sha256: pubkeyFingerprint(pubPem), value: signature };
    writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.equal(check().verified, true);
    assert.equal(check().signed, true);
    // Tamper with file contents → hashes fail.
    writeFileSync(join(appDir, 'demo.txt'), 'tampered');
    assert.equal(check().verified, false);
    // Restore files, corrupt the signature → never accepted even with allowUnsigned.
    writeFileSync(join(appDir, 'demo.txt'), 'demo data');
    const forged = JSON.parse(readFileSync(manifestFile, 'utf8'));
    forged.signature.value = Buffer.from('not-a-valid-signature').toString('base64');
    writeFileSync(manifestFile, JSON.stringify(forged));
    const report = portableIntegrityReport(appDir, manifestFile, { allowUnsigned: true });
    assert.equal(report.verified, false);
    assert.match(report.signature_error, /invalid/i);
  } finally { rmSync(appDir, { recursive: true, force: true }); }
});

test('unsigned manifest is accepted only under allowUnsigned', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'capsule-integrity-unsigned-'));
  try {
    const manifest = {
      schema_version: 1,
      algorithm: 'sha256',
      generated_at: new Date().toISOString(),
      files: [
        { path: 'demo.txt', bytes: 9, sha256: createHash('sha256').update('demo data').digest('hex') },
      ],
    };
    const manifestFile = join(appDir, 'capsule-integrity.json');
    writeFileSync(manifestFile, JSON.stringify(manifest));
    writeFileSync(join(appDir, 'demo.txt'), 'demo data');
    // No signature field and no allowUnsigned → refused.
    const strict = portableIntegrityReport(appDir, manifestFile);
    assert.equal(strict.verified, false);
    assert.match(strict.signature_error, /unsigned/i);
    // Same manifest with allowUnsigned (the keyless portable launcher path) → OK.
    const allowed = portableIntegrityReport(appDir, manifestFile, { allowUnsigned: true });
    assert.equal(allowed.verified, true);
    assert.equal(allowed.signed, false);
    // A changed file still fails even with allowUnsigned.
    writeFileSync(join(appDir, 'demo.txt'), 'tampered');
    assert.equal(portableIntegrityReport(appDir, manifestFile, { allowUnsigned: true }).verified, false);
  } finally { rmSync(appDir, { recursive: true, force: true }); }
});

test('regenerated manifests are idempotent: a second run does not rewrite', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const repoDir = process.cwd();
  const manifestPath = join(repoDir, 'capsule-integrity.json');
  const original = readFileSync(manifestPath, 'utf8');
  t.after(() => { writeFileSync(manifestPath, original); });
  // First run syncs the manifest to the current tree (signing key or not).
  await execFileAsync(process.execPath, ['tools/generate-integrity.mjs'], { cwd: repoDir });
  const before = statSync(manifestPath).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Second run must report "current" and leave the file byte-identical.
  const { stdout } = await execFileAsync(process.execPath, ['tools/generate-integrity.mjs'], { cwd: repoDir });
  assert.match(stdout, /current/i);
  assert.equal(statSync(manifestPath).mtimeMs, before);
});

test('chat store seals the workspace on disk and sanitizes input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-chats-'));
  try {
    const store = new ChatStore(dir);
    const saved = store.save({
      chats: [{ id: 'chat-1', title: 'Secret', messages: [{ role: 'user', content: 'hello' }] }],
      projects: [],
      activeId: 'chat-1',
    });
    assert.equal(saved.chats.length, 1);
    // On-disk blob is ciphertext, not the plaintext conversation.
    const raw = readFileSync(join(dir, 'workspace.json'), 'utf8');
    assert.doesNotMatch(raw, /hello/);
    // Key is private to the install.
    const keyStat = statSync(join(dir, 'chat-store.key'));
    assert.equal(keyStat.mode & 0o777, process.platform === 'win32' ? keyStat.mode & 0o777 : 0o600);
    // Reopening with the same key recovers the workspace.
    const again = new ChatStore(dir).get();
    assert.deepEqual(again.chats, saved.chats);
    // Privacy flag round-trips through the encrypted store.
    const privacyStore = new ChatStore(dir);
    privacyStore.save({ chats: [{ id: 'chat-priv', title: 'private chat', privacy: 'local', messages: [] }], projects: [], activeId: '' });
    const priv = new ChatStore(dir).get();
    assert.equal(priv.chats[0].privacy, 'local');
    // Ids are constrained to prevent path tricks; malicious ids are replaced.
    const hostile = store.save({ chats: [{ id: '../../escape', messages: [] }], projects: [], activeId: '' });
    assert.match(hostile.chats[0].id, /^chat-/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
