import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';
import { globSearch, revertLastAgentWrite, WRITE_HISTORY, executeTool } from '../lib/agent-loop.mjs';

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

test('globSearch finds files by pattern and skips ignored folders', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-glob-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'lib', 'deep'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.js'), '');
    writeFileSync(join(root, 'lib', 'deep', 'util.mjs'), '');
    writeFileSync(join(root, 'README.md'), '');
    writeFileSync(join(root, 'node_modules', 'skip.js'), '');
    writeFileSync(join(root, '.git', 'config'), '');

    const js = globSearch(root, '**/*.js');
    assert.deepEqual(js.sort(), ['src/app.js']);
    assert.ok(!js.includes('node_modules/skip.js'));

    const mjs = globSearch(root, 'lib/**/*.mjs');
    assert.deepEqual(mjs, ['lib/deep/util.mjs']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revertLastAgentWrite removes files the agent created and restores old contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-undo-'));
  try {
    const created = 'notes/new-file.txt';
    WRITE_HISTORY.push({ existed: false, path: created, content: null });
    let result = revertLastAgentWrite(root);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'removed');
    assert.equal(result.path, created);

    // A file that existed before: simulate "old" content, then snapshot a new write.
    const edited = 'notes/plan.txt';
    mkdirSync(dirname(join(root, edited)), { recursive: true });
    writeFileSync(join(root, edited), 'old version');
    WRITE_HISTORY.push({ existed: true, path: edited, content: 'old version' });
    writeFileSync(join(root, edited), 'new version');
    result = revertLastAgentWrite(root);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'restored');
    assert.equal(result.path, edited);
    assert.equal(readFileSync(join(root, edited), 'utf8'), 'old version');

    // Empty history → nothing to undo.
    assert.deepEqual(revertLastAgentWrite(root), { ok: false, error: 'Nothing to undo' });
    assert.equal(WRITE_HISTORY.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent tools server: git allowlist, find, and undo endpoints', async () => {
  const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);
  const port = await freePort();
  const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', (d) => { logs += d; });
  server.stderr.on('data', (d) => { logs += d; });

  const base = `http://127.0.0.1:${port}`;
  const call = async (path, init = {}) => {
    const r = await fetch(base + path, init);
    let body = null;
    try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const waitReady = async () => {
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(base + '/health'); if (r.status < 500) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('server did not become ready\n' + logs);
  };

  const tmpPath = `test/_agent-undo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.tmp`;
  try {
    await waitReady();

    const denied = await call('/api/agent/git', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: ['reset', '--hard'] }) });
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /Not allowed/);

    const deniedRm = await call('/api/agent/git', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: ['rm', '-rf', '.'] }) });
    assert.equal(deniedRm.status, 403);

    const status = await call('/api/agent/git', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args: ['status'] }) });
    assert.equal(status.status, 200);
    assert.equal(status.body.code, 0);

    const found = await call('/api/agent/find?pattern=*.md');
    assert.equal(found.status, 200);
    assert.ok(found.body.files.includes('README.md'));

    const badPattern = await call('/api/agent/find?pattern=' + encodeURIComponent('['));
    assert.equal(badPattern.status, 400);

    // Write then undo must leave no trace behind inside the real workspace.
    const wrote = await call('/api/agent/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: tmpPath, content: 'temp', approval: 'write' }) });
    assert.equal(wrote.status, 200);
    assert.ok(existsSync(join(repoRoot, tmpPath)));
    const undone = await call('/api/agent/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(undone.status, 200);
    assert.equal(undone.body.action, 'removed');
    assert.equal(undone.body.path, tmpPath);
    assert.equal(existsSync(join(repoRoot, tmpPath)), false);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => { server.once('exit', resolve); setTimeout(resolve, 3000); });
    rmSync(join(repoRoot, tmpPath), { force: true });
  }
});

test('executeTool web_search parses results and validates input', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => '<a class="result__a" href="https://example.com/?uddg=https%3A%2F%2Fexample.com%2Freal">Example Co</a><a class="result__snippet">A useful snippet.</a>',
  });
  try {
    const res = await executeTool('web_search', { query: 'hello world', num_results: 3 }, tmpdir(), { autonomy: 'auto' });
    assert.ok(Array.isArray(res), 'web_search returns an array of results');
    assert.equal(res.length, 1);
    assert.equal(res[0].url, 'https://example.com/real');
    assert.equal(res[0].title, 'Example Co');
    assert.equal(res[0].snippet, 'A useful snippet.');
  } finally {
    globalThis.fetch = prevFetch;
  }
  const missing = await executeTool('web_search', {}, tmpdir(), { autonomy: 'auto' });
  assert.match(missing.error, /No query/);
});

test('executeTool web_search retries once after a transient failure', async () => {
  const prevFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary outage');
    return { ok: true, text: async () => '<a class="result__a" href="https://x.test/">X</a><a class="result__snippet">s</a>' };
  };
  try {
    const res = await executeTool('web_search', { query: 'retry me', num_results: 2 }, tmpdir(), { autonomy: 'auto' });
    assert.equal(calls, 2, 'the search is attempted twice');
    assert.ok(Array.isArray(res) && res.length === 1, 'second attempt returns parsed results');
    assert.equal(res[0].url, 'https://x.test/');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('executeTool web_fetch extracts readable text and validates url', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => '<html><head><style>body{background:#fff}</style></head><body><script>evil()</script><nav>menu</nav><main><p>Hello&nbsp;World, capsule&nbsp;agent!</p></main></body></html>',
  });
  try {
    const res = await executeTool('web_fetch', { url: 'https://example.com/page' }, tmpdir(), { autonomy: 'auto' });
    assert.equal(res.url, 'https://example.com/page');
    assert.ok(/Hello World/.test(res.content), 'page text is extracted and entities decoded');
  } finally {
    globalThis.fetch = prevFetch;
  }
  const invalid = await executeTool('web_fetch', { url: 'not a url' }, tmpdir(), { autonomy: 'auto' });
  assert.match(invalid.error, /Invalid url/);
});

test('agent tools server: organize preview/apply/undo and thread memory endpoints', async () => {
  const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-thread-data-'));
  const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:1', LOCAL_AI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', (d) => { logs += d; });
  server.stderr.on('data', (d) => { logs += d; });

  const base = `http://127.0.0.1:${port}`;
  const call = async (path, init = {}) => {
    const r = await fetch(base + path, init);
    let body = null;
    try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const waitReady = async () => {
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(base + '/health'); if (r.status < 500) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('server did not become ready\n' + logs);
  };

  const orgDir = `test/_agent-org-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const mk = (p, content = 'x') => { const full = join(repoRoot, p); writeFileSync(full, content); return full; };
  try {
    await waitReady();
    mkdirSync(join(repoRoot, orgDir), { recursive: true });
    mk(`${orgDir}/a.txt`, 'note');
    mk(`${orgDir}/b.pdf`, 'doc');
    mk(`${orgDir}/c.jpg`, 'img');

    const plan = await call('/api/agent/organize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: orgDir, style: 'by_type' }) });
    assert.equal(plan.status, 200);
    assert.equal(plan.body.ok, true);
    assert.equal(plan.body.count, 3);
    assert.equal(plan.body.plan.length, 3);

    const applyDenied = await call('/api/agent/organize/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: orgDir, style: 'by_type' }) });
    assert.equal(applyDenied.status, 403);

    const apply = await call('/api/agent/organize/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: orgDir, style: 'by_type', approval: 'organize' }) });
    assert.equal(apply.status, 200);
    assert.equal(apply.body.applied, 3);
    const moved = apply.body.plan.map((m) => m.to);
    assert.ok(moved.every((to) => existsSync(join(repoRoot, to))));

    // Idempotence: applying again with everything already organized moves nothing.
    const onceMore = await call('/api/agent/organize/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: orgDir, style: 'by_type', approval: 'organize' }) });
    assert.equal(onceMore.status, 200);
    assert.equal(onceMore.body.applied, 0);

    // Undo reverts moves; after enough undos everything is back at its original path.
    for (let i = 0; i < 6; i += 1) {
      const undo = await call('/api/agent/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (undo.status !== 200) break;
    }
    for (const name of ['a.txt', 'b.pdf', 'c.jpg']) {
      assert.ok(existsSync(join(repoRoot, orgDir, name)), `${name} restored to its original folder`);
    }
    const nothing = await call('/api/agent/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(nothing.status, 400);

    // Thread memory: valid ids are accepted and cleaned up; hostile ids are rejected.
    const cleared = await call('/api/agent/thread?chat_id=test-chat-1', { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.ok, true);
    const hostile = await call('/api/agent/thread?chat_id=' + encodeURIComponent('../escape'), { method: 'DELETE' });
    assert.equal(hostile.status, 400);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => { server.once('exit', resolve); setTimeout(resolve, 3000); });
    rmSync(join(repoRoot, orgDir), { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});