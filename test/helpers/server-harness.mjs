// Shared "boot the real server in isolation" harness for HTTP-level tests.
//
// Extracted from test/cloud-router.test.mjs so every suite gets the same
// lifecycle: ephemeral port, temporary DATA_DIR, isolated HOME/USERPROFILE,
// health-wait, and guaranteed kill + cleanup via t.after. Each boot is its
// own server process with its own filesystem root, so suites running in
// parallel under node --test never share state.
//
//   const { base, call } = await bootServer(t);
//   const r = await call('/api/chatstate');
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { UserStore } from '../../lib/user-store.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TEST_PASSWORD = 'correct horse battery staple';

export function freePort() {
  return new Promise((resolve) => {
    const srv = netCreateServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Boot server.mjs as a subprocess on a free loopback port.
 * @param t              node:test context (cleanup is registered via t.after)
 * @param extraEnv       env vars merged last (e.g. CAPSULE_DENY_EGRESS)
 * @param removeEnv      host env vars to strip from the child process
 * @param seedFiles      { name: contents } written into DATA_DIR before spawn
 *                        (e.g. { 'ai_settings.env': 'AI_PROVIDER=openai\n' })
 * @param users          usernames to pre-create with TEST_PASSWORD (multi-user
 *                        is decided at boot — users.json must exist pre-spawn)
 * @param ollamaUrl      OLLAMA_URL to point at (default dead loopback; pass a
 *                        fake-ollama url for chat-path tests)
 * @param args           server argv before --host/--port
 * @param prepare        (root) => env — create fixtures inside the tmp home and
 *                        return any env vars the child needs for them
 */
export async function bootServer(t, {
  extraEnv = {},
  removeEnv = [],
  seedFiles = {},
  users = [],
  ollamaUrl = 'http://127.0.0.1:1',
  args = ['--mode', 'local'],
  prepare = null,
} = {}) {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'capsule-http-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  for (const [name, contents] of Object.entries(seedFiles)) writeFileSync(join(dataDir, name), contents);

  let seededUsers = {};
  if (users.length) {
    const store = new UserStore(join(dataDir, 'users.json'));
    for (const name of users) store.createUser(name, TEST_PASSWORD);
    store.close();
    seededUsers = Object.fromEntries(users.map((name) => [name, TEST_PASSWORD]));
  }

  const env = {
    ...process.env,
    LOCAL_AI_DATA_DIR: dataDir,
    OLLAMA_URL: ollamaUrl,
    HOME: root,
    USERPROFILE: root,
    CAPSULE_ALLOW_UNSIGNED: '1',
    ...(prepare ? prepare(root) : {}),
    ...extraEnv,
  };
  for (const key of removeEnv) delete env[key];

  const server = spawn(
    process.execPath,
    ['server.mjs', ...args, '--host', '127.0.0.1', '--port', String(port)],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let logs = '';
  server.stdout.on('data', (d) => { logs += d; });
  server.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(base + '/health'); if (r.status < 500) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  t.after(() => {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    base,
    root,
    dataDir,
    users: seededUsers,
    logs: () => logs,
    call: async (path, init = {}) => {
      const r = await fetch(base + path, init);
      let body = null;
      try { body = await r.json(); } catch {}
      return { status: r.status, body };
    },
  };
}