import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { randomBytes, randomInt } from 'crypto';
import {
  shamirSplit, shamirCombine, packBrain, unpackBrain, readBrainFiles,
  buildShardEnvelopes, readShardEnvelope, combineShardEnvelopes,
} from '../lib/escrow.mjs';

function fixtureDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-escrow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── Shamir KATs ──────────────────────────────────────────────────────────────
test('shamir: k-of-n round-trips arbitrary secrets across every k-share subset composition', () => {
  const secret = randomBytes(32);
  const shares = shamirSplit(secret, 5, 3);
  assert.equal(shares.length, 5);
  for (const subset of [[0, 1, 2], [2, 3, 4], [0, 2, 4], [1, 3, 0]]) {
    const rebuilt = shamirCombine(subset.map((i) => shares[i]));
    assert.deepEqual(rebuilt, secret);
  }
});

test('shamir: k−1 or fewer shares never reproduce the key', () => {
  const secret = Buffer.from('a'.repeat(32));
  const shares = shamirSplit(secret, 3, 2);
  for (const singles of [[shares[0]], [shares[1]], [shares[2]]]) {
    assert.throws(() => shamirCombine(singles), /at least 2/);
  }
  // A share byte stream must not contain raw secret material.
  for (const sh of shares) assert.notDeepEqual(sh.bytes, secret);
});

test('shamir: tampered share fails closed', () => {
  const secret = randomBytes(32);
  const [s1, s2] = shamirSplit(secret, 2, 2);
  const corrupt = Buffer.from(s2.bytes);
  corrupt[0] ^= 0xff;
  assert.notDeepEqual(shamirCombine([s1, { index: 2, bytes: corrupt }]), secret);
});

test('shamir: bad geometry and duplicate indexes are refused', () => {
  assert.throws(() => shamirSplit(randomBytes(4), 1, 1));
  assert.throws(() => shamirSplit(randomBytes(4), 300, 300), /255/);
  const shares = shamirSplit(randomBytes(16), 3, 2);
  assert.throws(() => shamirCombine([shares[0], shares[0]]), /duplicate/);
});

// ── Brain pack/unpack ────────────────────────────────────────────────────────
test('pack/unpack: memory+procedures round-trip through a shard set', (t) => {
  const dir = fixtureDir(t);
  writeFileSync(join(dir, 'memory.key'), randomBytes(32));
  writeFileSync(join(dir, 'memory-store.json.enc'), Buffer.from('sealed-fake-index'));
  writeFileSync(join(dir, 'procedures.json'), JSON.stringify({ procedures: [{ name: 'test' }] }));

  const { blob, brainKey } = packBrain({ dataDir: dir });
  const envs = buildShardEnvelopes({ brainKey, n: 3, k: 2, owner: 'alice', epoch: 'e_test1' });
  assert.equal(envs.length, 3);

  // Any two shards re-assemble the key, then the brain blob.
  const rebuiltKey = combineShardEnvelopes([envs[0], envs[2]]);
  assert.equal(rebuiltKey, brainKey);
  const files = unpackBrain({ blob, shards: [envs[0], envs[2]].map(readShardSafe) });
  assert.deepEqual(Object.keys(files).sort(), ['memory-store.json.enc', 'memory.key', 'procedures.json']);
  assert.equal(Buffer.from(files['memory-store.json.enc'], 'base64').toString(), 'sealed-fake-index');
  assert.equal(JSON.parse(files['procedures.json']).procedures[0].name, 'test');

  // One shard alone is nothing, and digesting it can't leak the key.
  const single = combineShardEnvelopesSafe([envs[0]]);
  assert.ok(single === null, 'a lone shard must not reconstruct');
});

function readShardSafe(env) {
  const clean = readShardEnvelope(env);
  return { index: clean.index, bytes: Buffer.from(clean.shard, 'base64') };
}
function combineShardEnvelopesSafe(envs) {
  try { return combineShardEnvelopes(envs); } catch { return null; }
}

test('pack/unpack: the passphrase is a true second factor — shards alone, blob alone, or wrong passphrase all fail', (t) => {
  const dir = fixtureDir(t);
  writeFileSync(join(dir, 'memory.key'), randomBytes(32));
  const { blob, brainKey } = packBrain({ dataDir: dir, passphrase: 'recovery phrase xyzzy' });
  const envs = buildShardEnvelopes({ brainKey, n: 2, k: 2, owner: 'alice', epoch: 'e_pass', blob });
  // shards + wrong passphrase → tag failure
  assert.throws(() => unpackBrain({ blob, shards: envs.map(readShardSafe), passphrase: 'wrong phrase' }));
  // shards + passphrase → opens
  const files = unpackBrain({ blob, shards: envs.map(readShardSafe), passphrase: 'recovery phrase xyzzy' });
  assert.ok(files['memory.key']);
  // no passphrase → refused outright
  assert.throws(() => unpackBrain({ blob, shards: envs.map(readShardSafe) }), /passphrase-fused/);
});

test('packBrain: refuses when there is nothing to escrow', (t) => {
  const dir = fixtureDir(t);
  assert.throws(() => packBrain({ dataDir: dir }), /found to escrow/i);
});

test('readBrainFiles: only real brain files are collected', (t) => {
  const dir = fixtureDir(t);
  mkdirSync(join(dir, 'chats'));
  writeFileSync(join(dir, 'chats', 'workspace.json'), 'not the brain');
  writeFileSync(join(dir, 'procedures.json'), JSON.stringify({ procedures: [] }));
  const files = readBrainFiles(dir);
  assert.deepEqual(Object.keys(files), ['procedures.json'], 'chat-store files stay out of the brain');
});

test('shard envelopes: strict validation and digest match across the set', () => {
  const brainKey = randomBytes(32).toString('base64');
  const envs = buildShardEnvelopes({ brainKey, n: 3, k: 2, owner: 'alice', epoch: 'e_v' });
  const digests = new Set(envs.map((e) => e.digest));
  assert.equal(digests.size, 1, 'every shard pins the same brain digest');
  assert.equal(new Set(envs.map((e) => e.epoch)).size, 1, 'same epoch');
  assert.throws(() => readShardEnvelope({ kind: 'note' }), /not an escrow/i);
  assert.throws(() => combineShardEnvelopes([{ kind: 'escrow', v: 1 }]), /Incomplete shard/);
});