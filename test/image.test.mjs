import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = netCreateServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function withServer(run) {
  const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'image-server-data-'));
  const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:1', LOCAL_AI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', (d) => { logs += d; });
  server.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, options = {}) => {
    const r = await fetch(base + path, options);
    let body = null;
    try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const waitReady = async () => {
    for (let i = 0; i < 150; i += 1) {
      try { const r = await fetch(base + '/health'); if (r.status < 500) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('server did not become ready\n' + logs);
  };
  try {
    await waitReady();
    await run(call);
  } finally {
    server.kill('SIGTERM');
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

test('image endpoints exist and report a not-yet-installed stack', async () => {
  await withServer(async (call) => {
    const status = await call('/api/image/status');
    assert.equal(status.status, 200);
    assert.equal(typeof status.body.engine, 'string', 'engine field is present');
    assert.equal(typeof status.body.installed, 'boolean', 'installed is a boolean');
    assert.equal(typeof status.body.supported, 'boolean', 'supported is a boolean');
    assert.equal(Array.isArray(status.body.job) || status.body.job === null, true, 'job is null when idle');
    assert.equal(typeof status.body.setup_hint, 'string');
    assert.ok(status.body.install, 'install sub-state is present');
    assert.equal(status.body.model, 'realistic-vision-v6-q8.gguf', 'status reports the pinned RV6 Q8 model');
    assert.ok(Math.abs(status.body.install_size_gb - 1.8) < 0.1, 'install size reflects the RV6 model');

    const files = await call('/api/image/files');
    assert.equal(files.status, 200);
    assert.ok(Array.isArray(files.body.images), 'files endpoint returns an image array');

    const missingFile = await call('/api/image/file/job-0000/0');
    assert.equal(missingFile.status, 404);

    const suspicious = await call('/api/image/file/..%2F..%2Fetc/0');
    assert.equal(suspicious.status, 404, 'path traversal attempts do not resolve');
  });
});

test('generate is rejected until the stack is installed', async () => {
  await withServer(async (call) => {
    const gen = await call('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'a red fox', width: 256, height: 256, steps: 8 }),
    });
    assert.equal(gen.status, 400);
    assert.match(gen.body.error || '', /not installed/i);
  });
});

test('generate validates the prompt', async () => {
  await withServer(async (call) => {
    const gen = await call('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    assert.equal(gen.status, 400);
    assert.match(gen.body.error || '', /prompt/i);
  });
});

test('generate validates sampler and scheduler against whitelists', async () => {
  await withServer(async (call) => {
    const badSampler = await call('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'a red fox', sampler: 'not-a-sampler' }),
    });
    assert.equal(badSampler.status, 400);
    assert.match(badSampler.body.error || '', /sampler/i);

    const badScheduler = await call('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'a red fox', scheduler: 'not-a-scheduler' }),
    });
    assert.equal(badScheduler.status, 400);
    assert.match(badScheduler.body.error || '', /scheduler/i);
  });
});