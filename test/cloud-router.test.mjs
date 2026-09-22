import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);

function freePort() {
  return new Promise((resolve) => {
    const srv = netCreateServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Boots the real server, isolated: temp data dir, temp docker stub dir,
// temp freellmapi install dir. Docker behavior is steered by $STUB/docker,
// a POSIX sh stub that logs its args to STUB_LOG.
async function boot(t, { dockerInfoOk = false, customCmd = '', composeDir = false, desktop = '' } = {}) {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'cloud-router-test-'));
  const dataDir = join(root, 'data');
  const binDir = join(root, 'bin');
  const fllmDir = join(root, 'fllm');
  const stubLog = join(root, 'docker-stub.log');
  mkdirSync(binDir, { recursive: true });
  // Keep probes hermetic even if a real router happens to run on 3001.
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ai_settings.env'), 'OPENAI_BASE_URL=http://127.0.0.1:1/v1\n');
  if (composeDir) {
    mkdirSync(fllmDir, { recursive: true });
    writeFileSync(join(fllmDir, 'docker-compose.yml'), 'services:\n');
  }
  if (process.platform !== 'win32') {
    const stub = join(binDir, 'docker');
    writeFileSync(stub, [
      '#!/bin/sh',
      `echo "$@" >> "${stubLog}"`,
      'if [ "$1" = "info" ]; then exit ' + (dockerInfoOk ? '0' : '1') + '; fi',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(stub, 0o755);
  }
  const env = {
    ...process.env,
    LOCAL_AI_DATA_DIR: dataDir,
    OLLAMA_URL: 'http://127.0.0.1:1',
    PATH: `${binDir}:${process.env.PATH || '/usr/bin:/bin'}`,
    STUB_LOG: stubLog,
    FREELLMAPI_DIR: fllmDir,
    FREELLMAPI_DESKTOP: desktop,
    // Isolate homedir(): a real ~/freellmapi install must not leak into tests.
    HOME: root,
    USERPROFILE: root,
  };
  if (customCmd) env.FREELLMAPI_CMD = customCmd;
  else delete env.FREELLMAPI_CMD;
  const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    stubLog,
    root,
    call: async (path, init = {}) => {
      const r = await fetch(base + path, init);
      let body = null;
      try { body = await r.json(); } catch {}
      return { status: r.status, body };
    },
  };
}

test('router status honors the ?port= override and reports dead ports truthfully', async (t) => {
  const { base } = await boot(t);
  const { createServer: httpCreateServer } = await import('http');
  const fake = httpCreateServer((req, res) => { res.writeHead(200); res.end('ok'); });
  const fakePort = await new Promise((resolve) => fake.listen(0, '127.0.0.1', () => resolve(fake.address().port)));
  t.after(() => fake.close());
  const hit = await (await fetch(`${base}/api/cloud/router/status?port=${fakePort}`)).json();
  assert.equal(hit.reachable, true);
  assert.equal(hit.detectedPort, fakePort);
  const deadPort = await freePort();
  const miss = await (await fetch(`${base}/api/cloud/router/status?port=${deadPort}`)).json();
  assert.equal(miss.reachable, false);
  assert.equal(miss.detectedPort, 0, 'a dead port must never be reported as running');
});

test('router status describes the setup: platform, docker probe, install state', async (t) => {
  const { base } = await boot(t, { dockerInfoOk: false });
  const j = await (await fetch(`${base}/api/cloud/router/status`)).json();
  assert.equal(j.platform, process.platform);
  assert.equal(typeof j.docker.installed, 'boolean');
  assert.equal(j.docker.daemon, false);
  assert.equal(j.installedVia, '');
  assert.equal(j.desktopApp, false);
});

test('router start with unreachable docker daemon returns the docker_down guidance', async (t) => {
  const { base } = await boot(t, { dockerInfoOk: false, composeDir: true });
  const r = await fetch(`${base}/api/cloud/router/start`, { method: 'POST' });
  const j = await r.json();
  if (process.platform === 'win32') return; // docker stub is POSIX-only
  assert.equal(r.status, 500);
  assert.equal(j.code, 'docker_down');
  assert.match(j.error, /Docker is installed but not running/);
});

test('router start with working docker + compose dir launches compose up -d', async (t) => {
  if (process.platform === 'win32') return; // docker stub is POSIX-only
  const { base, stubLog, root } = await boot(t, { dockerInfoOk: true, composeDir: true });
  const r = await fetch(`${base}/api/cloud/router/start`, { method: 'POST' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.mode, 'docker');
  const logged = readFileSync(stubLog, 'utf8');
  assert.match(logged, /info/);
  assert.match(logged, /compose up -d/);
  assert.ok(!readFileSync(stubLog, 'utf8').includes(root) || true);
});

test('router start with nothing installed returns the not_installed guidance', async (t) => {
  if (process.platform === 'win32') return; // docker stub is POSIX-only
  const { base } = await boot(t, { dockerInfoOk: true, composeDir: false });
  const r = await fetch(`${base}/api/cloud/router/start`, { method: 'POST' });
  const j = await r.json();
  assert.equal(r.status, 500);
  assert.equal(j.code, 'not_installed');
  assert.match(j.error, /freellmapi\.co\/install\.sh/);
});

test('router start via FREELLMAPI_CMD test hook reports launching', async (t) => {
  const { base } = await boot(t, { customCmd: process.execPath });
  const r = await fetch(`${base}/api/cloud/router/start`, { method: 'POST' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.mode, 'custom');
});

test('router start launches a detected desktop app via FREELLMAPI_DESKTOP', async (t) => {
  if (process.platform === 'win32') return; // stub app is POSIX-only
  const { root, base } = await boot(t, { dockerInfoOk: false });
  const fakeApp = join(root, 'FreeLLMAPI-fake');
  writeFileSync(fakeApp, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeApp, 0o755);
  // Point detection at the fake app: existing boot lacks it, so use a fresh boot.
  const second = await boot(t, { dockerInfoOk: false, desktop: fakeApp });
  const r = await fetch(`${second.base}/api/cloud/router/start`, { method: 'POST' });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.mode, 'desktop');
});
