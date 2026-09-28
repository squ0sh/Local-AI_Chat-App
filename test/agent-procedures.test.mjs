import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);

function freePort() {
  return new Promise((resolve) => {
    const srv = netCreateServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function boot(t) {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'proc-test-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ai_settings.env'), 'OPENAI_BASE_URL=http://127.0.0.1:9/v1\n');
  const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, LOCAL_AI_DATA_DIR: dataDir, OLLAMA_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { server.kill(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(base + '/health'); if (r.status < 500) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { base, dataDir };
}

const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ritual = (over = {}) => ({ name: 'Dependency update ritual', summary: 'safe npm bumps', steps: ['verify tests pass first', 'bump one dependency at a time', 'retest between bumps'], ...over });

test('procedures CRUD: create, list, use-count, delete', async (t) => {
  const { base } = await boot(t);
  const created = await (await post(base, '/api/agent/procedures', ritual())).json();
  assert.ok(created.ok && created.procedure.id.startsWith('proc-'));
  assert.equal(created.procedure.uses, 0);

  const list = (await (await fetch(`${base}/api/agent/procedures`)).json()).procedures;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Dependency update ritual');

  const used = await (await post(base, '/api/agent/procedures/use', { id: created.procedure.id })).json();
  assert.equal(used.uses, 1);

  const del = await fetch(`${base}/api/agent/procedures?id=${created.procedure.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await (await fetch(`${base}/api/agent/procedures`)).json()).procedures.length, 0);
});

test('procedures validation: name+steps required, caps enforced, bad id rejected', async (t) => {
  const { base } = await boot(t);
  const noSteps = await post(base, '/api/agent/procedures', { name: 'x', steps: [] });
  assert.equal(noSteps.status, 400);
  const huge = await post(base, '/api/agent/procedures', ritual({ name: 'a'.repeat(90), steps: ['x'.repeat(400)] }));
  assert.equal(huge.status, 200);
  const saved = huge && (await huge.json()).procedure;
  assert.ok(saved.name.length <= 60 && saved.steps[0].length <= 220, 'caps applied');
  const badUse = await post(base, '/api/agent/procedures/use', { id: '../../etc' });
  assert.equal(badUse.status, 400);
});

test('suggest: token-prefix matching beats plurals; unrelated tasks stay silent', async (t) => {
  const { base } = await boot(t);
  await post(base, '/api/agent/procedures', ritual());
  const hit = (await (await fetch(`${base}/api/agent/procedures/suggest?task=${encodeURIComponent('update my npm dependencies safely please')}`)).json()).suggestions;
  assert.equal(hit.length, 1);
  assert.equal(hit[0].name, 'Dependency update ritual');
  const miss = (await (await fetch(`${base}/api/agent/procedures/suggest?task=${encodeURIComponent('draw me a fox')}`)).json()).suggestions;
  assert.equal(miss.length, 0);
  const short = (await (await fetch(`${base}/api/agent/procedures/suggest?task=${encodeURIComponent('hi')}`)).json()).suggestions;
  assert.equal(short.length, 0);
});

test('distill falls back to a trail-based template when the model is offline', async (t) => {
  const { base } = await boot(t);
  const r = await post(base, '/api/agent/procedures/distill', { task: 'bump npm deps safely', content: 'done', trail: ['run_command', 'run_tests'], model: 'nope:0b' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.distilled, false);
  assert.ok(Array.isArray(j.procedure.steps) && j.procedure.steps.length >= 2);
  assert.ok(j.procedure.steps.join(' ').includes('run_command'));
  assert.ok(j.procedure.name.startsWith('Procedure:'));
});

test('procedures persist under data dir (and nowhere near the sealed skills.json)', async (t) => {
  const { base, dataDir } = await boot(t);
  await post(base, '/api/agent/procedures', ritual());
  assert.ok(existsSync(join(dataDir, 'procedures.json')));
  const listed = JSON.parse(readFileSync(join(dataDir, 'procedures.json'), 'utf8'));
  assert.equal(listed.procedures[0].name, 'Dependency update ritual');
});
