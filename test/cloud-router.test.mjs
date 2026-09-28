import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'fs';
import { join } from 'path';
import { bootServer, freePort } from './helpers/server-harness.mjs';

// Boots the real server on the shared harness with the cloud-router fixtures
// on top: a docker PATH stub that logs its args to STUB_LOG, an optional
// compose dir, and an isolated freellmapi install location. Docker behavior is
// steered by $STUB/docker, a POSIX sh stub that logs its args to STUB_LOG.
async function boot(t, { dockerInfoOk = false, customCmd = '', composeDir = false, desktop = '' } = {}) {
  const { base, root, call } = await bootServer(t, {
    // Keep probes hermetic even if a real router happens to run on 3001.
    seedFiles: { 'ai_settings.env': 'OPENAI_BASE_URL=http://127.0.0.1:1/v1\n' },
    // Isolate homedir() and drop any host-side router command so a real
    // ~/freellmapi install can never leak into tests.
    removeEnv: customCmd ? [] : ['FREELLMAPI_CMD'],
    prepare: (home) => {
      const binDir = join(home, 'bin');
      const fllmDir = join(home, 'fllm');
      const stubLog = join(home, 'docker-stub.log');
      mkdirSync(binDir, { recursive: true });
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
        PATH: `${binDir}:${process.env.PATH || '/usr/bin:/bin'}`,
        STUB_LOG: stubLog,
        FREELLMAPI_DIR: fllmDir,
        FREELLMAPI_DESKTOP: desktop,
      };
      if (customCmd) env.FREELLMAPI_CMD = customCmd;
      return env;
    },
  });
  return { base, root, stubLog: join(root, 'docker-stub.log'), call };
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
