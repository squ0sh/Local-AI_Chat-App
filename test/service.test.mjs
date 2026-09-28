import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);
const SERVICE_AUTHOR = join(repoRoot, 'tools', 'service.sh');
const SERVICE_CMD = join(repoRoot, 'tools', 'service.cmd');

function sandbox(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'capsule-service-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'portable', 'data');
  // The service tool resolves against the kit's .portable dir; the sandbox
  // Can't move APP_DIR, so CAPSULE_USERS_FILE redirects the users.json probe.
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, dataDir };
}

function run(t, args, { platform = 'Linux', xdgHome, home, authToken, extraEnv = {} } = {}) {
  const { root } = sandbox(t);
  const env = {
    ...process.env,
    LOCAL_AI_SERVICE_PLATFORM: platform,
    ...(xdgHome ? { XDG_CONFIG_HOME: xdgHome } : {}),
    ...(home ? { HOME: home } : {}),
    ...(authToken !== undefined ? { AUTH_TOKEN: authToken } : { AUTH_TOKEN: '' }),
    //! A sandbox must never see the developer's real users.json:
    CAPSULE_USERS_FILE: join(root, 'no-users-here', 'users.json'),
    // The installer verifies the signed manifest against the live tree; tests
    // may legitimately run with tracked files dirty mid-edit, so skip it here.
    CAPSULE_SERVICE_SKIP_INTEGRITY: '1',
    ...extraEnv,
  };
  const proc = spawnSync('bash', [SERVICE_AUTHOR, ...args, '--dry-run'], { cwd: repoRoot, env, encoding: 'utf8' });
  return { code: proc.status, stdout: proc.stdout || '', stderr: proc.stderr || '', root };
}

// ── Linux systemd path (fully exercisable here) ─────────────────────────────
test('service install writes a hardened systemd user unit (--dry-run)', (t) => {
  const { root } = sandbox(t);
  const xdg = join(root, 'config');
  const proc = run(t, ['install'], { xdgHome: xdg, authToken: 'test-token-123' });
  assert.equal(proc.code, 0, proc.stderr);
  const unit = join(xdg, 'systemd', 'user', 'local-ai-capsule.service');
  assert.ok(existsSync(unit), 'unit file was written');
  const body = readFileSync(unit, 'utf8');
  assert.match(body, /ExecStart=\/usr\/bin\/env bash .*\/start-portable\.sh/, 'service starts the portable launcher');
  assert.match(body, /Environment=LOCAL_AI_NO_BROWSER=1/, 'no browser pops on the service box');
  assert.match(body, /Restart=on-failure/, 'restarts on crash');
  assert.match(body, /NoNewPrivileges=true/, 'privilege separation');
  assert.match(body, /WantedBy=default.target/, 'user-session autostart');
  assert.match(proc.stdout, /loginctl enable-linger/, 'lingering hint is printed');
});

test('service install refuses without any auth (no AUTH_TOKEN, no users.json)', (t) => {
  const proc = run(t, ['install'], {});
  assert.equal(proc.code, 1);
  assert.match(proc.stderr, /refusing to install an open service/);
  assert.match(proc.stderr, /AUTH_TOKEN/);
  assert.match(proc.stderr, /user-store\.mjs/, 'points the operator at multi-user');
});

test('service install accepts --allow-open as an explicit risk opt-in', (t) => {
  const { root } = sandbox(t);
  const xdg = join(root, 'config');
  const proc = run(t, ['install', '--allow-open'], { xdgHome: xdg });
  assert.equal(proc.code, 0, proc.stderr);
  assert.ok(existsSync(join(xdg, 'systemd', 'user', 'local-ai-capsule.service')));
  assert.match(proc.stdout, /--allow-open/);
});

test('service install honors existing multi-user accounts (auth is the installer\'s choice)', (t) => {
  const { root } = sandbox(t);
  const usersFile = join(root, 'someplace', 'users.json');
  mkdirSync(join(root, 'someplace'), { recursive: true });
  writeFileSync(usersFile, JSON.stringify({ v: 1, users: [{ username: 'alice' }] }));
  const proc = run(t, ['install'], { xdgHome: join(root, 'config'), extraEnv: { CAPSULE_USERS_FILE: usersFile } });
  assert.equal(proc.code, 0, proc.stderr);
  assert.match(proc.stdout, /multi-user accounts found/);
});

test('service uninstall removes the unit and never touches data', (t) => {
  const { root } = sandbox(t);
  const xdg = join(root, 'config');
  const unit = join(xdg, 'systemd', 'user', 'local-ai-capsule.service');
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, '[Unit]\n');
  const proc = run(t, ['uninstall'], { xdgHome: xdg });
  assert.equal(proc.code, 0, proc.stderr);
  assert.ok(!existsSync(unit), 'unit removed');
  assert.match(proc.stdout, /data and models were left alone/);
});

// ── macOS launchd path (generated shape tested; launchctl cannot run here) ──
test('service install generates a launchd plist on Darwin', (t) => {
  const { root } = sandbox(t);
  const home = join(root, 'home');
  const proc = run(t, ['install'], { platform: 'Darwin', home, authToken: 'test-token-123' });
  assert.equal(proc.code, 0, proc.stderr);
  const plist = join(home, 'Library', 'LaunchAgents', 'com.localai.capsule.plist');
  assert.ok(existsSync(plist), 'plist written under the LaunchAgents override');
  const body = readFileSync(plist, 'utf8');
  assert.match(body, /<key>Label<\/key><string>com\.localai\.capsule<\/string>/);
  assert.match(body, /<key>KeepAlive<\/key>/);
  assert.match(body, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(body, /<key>LOCAL_AI_NO_BROWSER<\/key><string>1<\/string>/);
  assert.match(body, /start-portable\.sh/, 'same portable launcher is the program');
  assert.match(body, /AUTH_TOKEN/, 'auth token propagates into the plist env');
  assert.match(proc.stdout, /launchctl bootstrap/, 'tells the user how to load it');
});

// ── Windows Task Scheduler helper (generated file is shape-checked only) ────
test('service.cmd wraps the portable kit in a logon task', () => {
  const cmd = readFileSync(SERVICE_CMD, 'utf8');
  assert.match(cmd, /schtasks \/Create \/TN "%TASK_NAME%"/);
  assert.match(cmd, /start-portable\.cmd/, 'the task launches the same portable kit');
  assert.match(cmd, /refusing to install an open service/, 'auth gate text mirrors service.sh');
  assert.match(cmd, /schtasks \/Delete/, 'uninstall path is present');
  assert.match(cmd, /schtasks \/Query/, 'status path is present');
});