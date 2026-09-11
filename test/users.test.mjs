import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { UserStore } from '../lib/user-store.mjs';

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-users-'));
  const file = join(dir, 'users.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new UserStore(file);
}

test('users: create, duplicate, weak password, and round-trip login', (t) => {
  const s = openStore(t);
  assert.equal(s.enabled(), false);
  assert.equal(s.createUser('Alice', 'correct horse battery staple'), 'alice');
  assert.equal(s.enabled(), true);
  assert.equal(s.list().length, 1);
  assert.throws(() => s.createUser('alice', 'another password 1234'), /already exists/);
  assert.throws(() => s.createUser('bob', 'short'), /at least 8/);
  assert.throws(() => s.createUser('bad name!', 'password 1234'), /Username must/);
  assert.equal(s.verifyLogin('alice', 'correct horse battery staple'), true);
  assert.equal(s.verifyLogin('ALICE', 'correct horse battery staple'), true);
  assert.equal(s.verifyLogin('alice', 'wrong password xxxx'), false);
  assert.equal(s.verifyLogin('nobody', 'correct horse battery staple'), false);
  const stored = JSON.parse(readFileSync(s.file, 'utf8'));
  assert.equal(stored.users[0].username, 'alice');
  assert.doesNotMatch(JSON.stringify(stored), /correct horse battery staple/);
  assert.ok(stored.users[0].salt && stored.users[0].hash);
});

test('users: sessions issue, resolve, expire, and invalidate', (t) => {
  const s = openStore(t);
  s.createUser('alice', 'correct horse battery staple');
  const token = s.issueSession('alice');
  assert.equal(token.length, 43);
  assert.equal(s.resolve(token), 'alice');
  assert.equal(s.resolve('not-a-real-token'), null);
  assert.equal(s.resolve(''), null);
  assert.equal(s.issueSession('nobody'), null);
  const t2 = s.issueSession('alice');
  assert.notEqual(t2, token);
  s.invalidate(token);
  assert.equal(s.resolve(token), null);
  assert.equal(s.resolve(t2), 'alice');
  const t3 = s.issueSession('alice');
  s.sessions.get(t3).expiresAt = Date.now() - 1000;
  s.expireSessions();
  assert.equal(s.resolve(t3), null);
  assert.equal(s.resolve(t2), 'alice');
});

test('users: token format survives JSON and is URL-safe', (t) => {
  const s = openStore(t);
  s.createUser('alice', 'correct horse battery staple');
  const token = s.issueSession('alice');
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.ok(!token.includes('=') && !token.includes('+') && !token.includes('/'));
});