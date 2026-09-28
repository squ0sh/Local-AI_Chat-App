// Brain escrow: Shamir k-of-n secret sharing plus the Capsule brain pack/unpack
// for social recovery. A capsule's brain is its memory key + memory index +
// procedures — the parts that make it *yours* — wrapped small, sealed with a
// passphrase-derived wrap when offered, and splittable across trusted peers.
//
// Nothing here touches the network: the transport is the existing postcard
// system, and the consent grammar is the same approval inbox as everything
// else. This module is deliberately pure logic so every step is testable.
import { randomBytes, createHash, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const ESCROW_VERSION = 1;
export const SHARD_KIND = 'escrow';

// ── GF(256), AES polynomial 0x11b, generator 0x03 ───────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function setupGf() {
  // In GF(2^8) with the AES polynomial, the cyclic generator is 3, not 2.
  // Multiply by xtime(x) XOR x (i.e. *2 *1) per step so EXP/LOG span all 255
  // non-zero elements exactly once.
  const xtime = (v) => {
    let r = v << 1;
    if (v & 0x80) r ^= 0x11b;
    return r & 0xff;
  };
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x = xtime(x) ^ x;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
// a / b in GF: log-space subtraction (b must not be 0)
const gfDiv = (a, b) => EXP[(LOG[a] - LOG[b] + 255) % 255];

// Shamir split/combine over each byte independently. Indexes are 1..n — share
// 0 would leak the secret directly, so x=0 is never issued.
export function shamirSplit(secret, n, k) {
  const bytes = Buffer.from(secret);
  if (!bytes.length) throw new Error('empty secret');
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 2 || n > 255 || k < 2 || k > n) {
    throw new Error('need 2 <= k <= n <= 255');
  }
  const shares = Array.from({ length: n }, () => Buffer.alloc(bytes.length));
  for (let b = 0; b < bytes.length; b += 1) {
    // coeff[0] is the secret byte; coeffs 1..k-1 are random points of a poly
    const coeff = [bytes[b], ...randomBytes(k - 1)];
    for (let i = 0; i < n; i += 1) {
      const x = i + 1;
      let y = 0;
      for (let d = k - 1; d >= 0; d -= 1) y = gfMul(y, x) ^ coeff[d];
      shares[i][b] = y;
    }
  }
  return shares.map((sh, i) => ({ index: i + 1, bytes: sh }));
}

// Lagrange interpolation at x=0 over any k of the shares.
export function shamirCombine(shares) {
  if (!Array.isArray(shares) || shares.length < 2) throw new Error('need at least 2 shares');
  const len = shares[0].bytes.length;
  for (const sh of shares) if (sh.bytes.length !== len) throw new Error('share sizes differ');
  const idx = shares.map((s) => s.index);
  if (new Set(idx).size !== idx.length) throw new Error('duplicate share indexes');
  for (const i of idx) if (!i || i < 1 || i > 255) throw new Error('invalid share index');
  const out = Buffer.alloc(len);
  for (let b = 0; b < len; b += 1) {
    let acc = 0;
    for (let i = 0; i < shares.length; i += 1) {
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j += 1) {
        if (i === j) continue;
        num = gfMul(num, shares[j].index);
        den = gfMul(den, shares[i].index ^ shares[j].index);
      }
      acc ^= gfMul(shares[i].bytes[b], gfDiv(num, den));
    }
    out[b] = acc;
  }
  return out;
}

const KEY_BYTES = 32;
const KDF = { name: 'scrypt', N: 1 << 15, r: 8, p: 1 };

// ── Brain payload: what the brain actually is on disk today ─────────────────
// The recall brain = the mode-600 AES key + the sealed memory store, plus your
// procedures (the plaintext personal file). Vault passphrases and chat history
// are intentionally NOT included: passphrases are remembered by their owner,
// chats are per-user and can follow in a v2.
export function readBrainFiles(dataDir) {
  const keyFile = join(dataDir, 'memory.key');
  const storeFile = join(dataDir, 'memory-store.json.enc');
  const procFile = join(dataDir, 'procedures.json');
  const files = {};
  if (existsSync(keyFile)) files['memory.key'] = readFileSync(keyFile).toString('base64');
  if (existsSync(storeFile)) files['memory-store.json.enc'] = readFileSync(storeFile).toString('base64');
  if (existsSync(procFile)) files['procedures.json'] = readFileSync(procFile).toString('utf8');
  return Object.keys(files).length ? files : null;
}

// Pack → { blob, brainKey } where blob is base64 of the sealed payload and the
// brainKey is what gets split. When a passphrase is given, the brainKey is
// additionally sealed with it — the shards alone cannot unwrap the blob.
// Pack → { blob, brainKey } where blob is base64 of the sealed payload and the
// brainKey is what gets split. When a passphrase is given, the payload is
// sealed under brainKey XOR scrypt(passphrase) — the Shamir shares are then
// genuinely two-factor: neither the shard set nor the passphrase alone opens
// the brain.
export function packBrain({ dataDir, passphrase = '' }) {
  const files = readBrainFiles(dataDir);
  if (!files) throw new Error('No memory or procedures found to escrow');
  const brainKey = randomBytes(KEY_BYTES);
  const salt = randomBytes(16);
  const payloadKey = passphrase
    ? Buffer.from(brainKey.map((b, i) => b ^ scryptSync(String(passphrase), salt, KEY_BYTES, { ...KDF, maxmem: 64 * 1024 * 1024 })[i]))
    : brainKey;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', payloadKey, iv);
  const plaintext = Buffer.from(JSON.stringify({ v: ESCROW_VERSION, files }), 'utf8');
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    blob: JSON.stringify({
      v: ESCROW_VERSION,
      hasPass: Boolean(passphrase),
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: sealed.toString('base64'),
    }),
    brainKey: brainKey.toString('base64'),
    wrapped: Boolean(passphrase),
  };
}

// Reassemble: shards → brainKey; if the blob was passphrase-fused, the same
// passphrase recomputes the payload key — a wrong one is caught by the GCM tag.
export function unpackBrain({ blob, shards, passphrase = '' }) {
  const brainKey = Buffer.from(shamirCombine(shards));
  const record = JSON.parse(blob);
  if (record.v !== ESCROW_VERSION) throw new Error('Unknown brain version: ' + record.v);
  let keyBytes = brainKey;
  if (record.hasPass) {
    if (!passphrase) throw new Error('This brain is passphrase-fused');
    const kek = scryptSync(String(passphrase), Buffer.from(record.salt, 'base64'), KEY_BYTES, { ...KDF, maxmem: 64 * 1024 * 1024 });
    keyBytes = Buffer.from(brainKey.map((b, i) => b ^ kek[i]));
  }
  const decipher = createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  const opened = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
  const payload = JSON.parse(opened.toString('utf8'));
  return payload.files;
}

// ── Shard envelopes (what a postcard carries) ─────────────────────────────────
// The sealed brain blob travels WITH every shard (identical ciphertext; the
// peer still can't open it). The owner's outside data dir may burn down;
// recovery only needs the retainers' envelopes.
const digest = (s) => createHash('sha256').update(s).digest('base64').slice(0, 24);

export function buildShardEnvelopes({ brainKey, n, k, owner, epoch, blob = '' }) {
  const shares = shamirSplit(Buffer.from(brainKey, 'base64'), n, k);
  return shares.map((s) => ({
    v: ESCROW_VERSION,
    kind: SHARD_KIND,
    epoch,
    index: s.index,
    threshold: k,
    total: n,
    owner,
    shard: s.bytes.toString('base64'),
    blob,
    digest: digest(brainKey + '|' + blob),
    issuedAt: new Date().toISOString(),
  }));
}

export function readShardEnvelope(env) {
  if (!env || env.kind !== SHARD_KIND) throw new Error('Not an escrow shard');
  if (env.v !== ESCROW_VERSION) throw new Error('Unknown escrow shard version: ' + env.v);
  if (!env.index || !env.shard || !env.threshold) throw new Error('Incomplete shard envelope');
  return env;
}

export function combineShardEnvelopes(envs) {
  const shards = [];
  for (const env of envs) {
    const clean = readShardEnvelope(env);
    shards.push({ index: clean.index, bytes: Buffer.from(clean.shard, 'base64') });
  }
  return Buffer.from(shamirCombine(shards)).toString('base64');
}
