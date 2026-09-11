import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const CHEAP = 1 << 12;
const SESSION_TTL_MS = 10 * 60 * 60 * 1000;

function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
  writeFileSync(tmp, data);
  if (process.platform !== 'win32') { try { chmodSync(tmp, 0o600); } catch {} }
  renameSync(tmp, file);
}

function hashPassword(password, salt = randomBytes(16)) {
  const derived = scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString('base64'), hash: derived.toString('base64') };
}

function cheapHash(value) {
  return scryptSync(value, 'capsule-sessions', 32, { N: CHEAP, r: 8, p: 1, maxmem: 16 * 1024 * 1024 }).toString('base64');
}

function safeEqual(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Optional multi-user profile layer. OFF by default: unless a users.json with
 * at least one user exists, every existing single-operator flow is untouched.
 * When enabled, every request except /api/auth/login must carry a valid session
 * token (bearer header or HttpOnly cookie). Passwords are scrypt-hashed; the
 * file is written 0600 on POSIX systems.
 */
export class UserStore {
  constructor(usersFile) {
    this.file = usersFile;
    this.sessions = new Map();
    this.timer = setInterval(() => this.expireSessions(), 60_000);
    this.timer.unref?.();
  }

  enabled() {
    try {
      const users = this.list();
      return users.length > 0;
    } catch { return false; }
  }

  list() {
    if (!existsSync(this.file)) return [];
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    return Array.isArray(data.users) ? data.users.map((u) => u.username) : [];
  }

  createUser(username, password) {
    const name = String(username || '').trim().toLowerCase();
    if (!name || !/^[a-z0-9._-]{2,40}$/.test(name)) throw new Error('Username must be 2-40 chars using letters, digits, dot, dash, underscore');
    if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');
    const data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { v: 1, users: [] };
    const users = Array.isArray(data.users) ? data.users : [];
    if (users.some((u) => u.username === name)) throw new Error('User already exists: ' + name);
    const { salt, hash } = hashPassword(String(password));
    users.push({ username: name, salt, hash, created_at: new Date().toISOString() });
    writeAtomic(this.file, JSON.stringify({ v: 1, users }, null, 2) + '\n');
    return name;
  }

  verifyLogin(username, password) {
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    const user = data.users.find((u) => u.username === String(username || '').trim().toLowerCase());
    if (!user) return false;
    const { salt, hash } = hashPassword(String(password), Buffer.from(user.salt, 'base64'));
    return safeEqual(hash, user.hash);
  }

  issueSession(username) {
    const name = String(username || '').trim().toLowerCase();
    if (!this.list().includes(name)) return null;
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { username: name, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  resolve(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) { this.sessions.delete(token); return null; }
    return session.username;
  }

  invalidate(token) {
    this.sessions.delete(token);
  }

  expireSessions() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(token);
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
  }
}

export function hashSessionToken(token) {
  return cheapHash(token);
}

export function hashUserSecret(username, secret) {
  return createHash('sha256').update(username + ':').update(secret, 'utf8').digest('hex');
}

// CLI shim: node lib/user-store.mjs create <username> <password> [--file path]
if (process.argv[1] && process.argv[1].endsWith('user-store.mjs')) {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : join(dirname(new URL(import.meta.url).pathname), '..', 'data', 'users.json');
  if (args[0] === 'create' && args[1] && args[2]) {
    try {
      const store = new UserStore(file);
      const name = store.createUser(args[1], args[2]);
      console.log('Created user ' + name + ' in ' + file);
      store.close();
    } catch (e) { console.error('Error: ' + e.message); process.exitCode = 1; }
  } else {
    console.log('Usage: node lib/user-store.mjs create <username> <password> [--file data/users.json]');
    process.exitCode = 1;
  }
}