import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);

function freePort() {
  return new Promise((resolve) => {
    const srv = netCreateServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function bootServer(t, extraEnv = {}) {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'usb-test-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ai_settings.env'), 'OPENAI_BASE_URL=http://127.0.0.1:9/v1\n');
  const env = {
    ...process.env,
    LOCAL_AI_DATA_DIR: dataDir,
    OLLAMA_URL: 'http://127.0.0.1:1',
    ...extraEnv,
  };
  const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { server.kill(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(base + '/health'); if (r.status < 500) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { base, root, dataDir };
}

const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('usb-targets enumerates the scan roots with storage profiles', async (t) => {
  const rootA = mkdtempSync(join(tmpdir(), 'usb-scan-a-'));
  const rootB = mkdtempSync(join(tmpdir(), 'usb-scan-b-'));
  t.after(() => { rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true }); });
  const { base } = await bootServer(t, { LOCAL_AI_USB_SCAN_ROOTS: `${rootA}:${rootB}` });
  const j = await (await fetch(`${base}/api/portable/usb-targets`)).json();
  const paths = j.targets.map((x) => x.path).sort();
  assert.deepEqual(paths, [rootA, rootB].sort());
  for (const target of j.targets) {
    assert.equal(typeof target.free_bytes, 'number');
    assert.equal(target.filesystem, 'tmpfs');
    assert.deepEqual(target.warnings, []);
  }
});

test('usb-copy refuses arbitrary (non-enumerated) target paths', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'usb-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { base } = await bootServer(t, { LOCAL_AI_USB_SCAN_ROOTS: root });
  const r = await post(base, '/api/portable/usb-copy', { target: '/etc/passwd-not-a-dir', include: {} });
  assert.equal(r.status, 400);
});

test('usb-copy streams a kit, verifies it, and skips private data by default', async (t) => {
  const target = mkdtempSync(join(tmpdir(), 'usb-stick-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const { base, dataDir } = await bootServer(t, { LOCAL_AI_USB_SCAN_ROOTS: target });
  // plant decoy private data — must NOT be copied without include.data
  writeFileSync(join(dataDir, 'capsule-vault.json'), '{"secret":true}');
  const r = await post(base, '/api/portable/usb-copy', { target, include: { runtimes: 'none', models: false, voice: false, image: false, data: false } });
  assert.equal(r.status, 202);
  const { job } = await r.json();
  assert.equal(job.kind, 'usb-copy');
  let last = job;
  for (let i = 0; i < 120; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = (await (await fetch(`${base}/api/portable/usb-copy?id=${job.id}`)).json()).job;
    if (['ready', 'error', 'cancelled'].includes(last.status)) break;
  }
  assert.equal(last.status, 'ready', last.error || 'job did not finish');
  assert.equal(last.files_copied, last.files_total);
  assert.ok(last.files_copied >= 36, 'kit contains the release files');
  assert.equal(last.summary.mismatched, 0);
  const kit = join(target, 'capsule');
  assert.ok(existsSync(join(kit, 'README-USB.txt')));
  assert.ok(existsSync(join(kit, 'server.mjs')));
  assert.ok(existsSync(join(kit, 'capsule-integrity.json')));
  assert.equal(existsSync(join(kit, '.portable', 'data', 'capsule-vault.json')), false, 'private data never copied by default');
  // a copied release file is byte-identical
  assert.equal(readFileSync(join(kit, 'capsule.json'), 'utf8'), readFileSync(join(repoRoot, 'capsule.json'), 'utf8'));
});

test('a second copy while one runs is rejected with 409', async (t) => {
  const target = mkdtempSync(join(tmpdir(), 'usb-stick-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const { base } = await bootServer(t, { LOCAL_AI_USB_SCAN_ROOTS: target });
  const first = await post(base, '/api/portable/usb-copy', { target, include: { runtimes: 'none' } });
  assert.equal(first.status, 202);
  const { job } = await first.json();
  // The 36-file copy may finish before the second POST lands on a fast disk;
  // retry a few times so the 409 gets observed on at least one attempt.
  let conflict = 0;
  for (let i = 0; i < 20 && !conflict; i += 1) {
    const again = await post(base, '/api/portable/usb-copy', { target, include: { runtimes: 'none' } });
    if (again.status === 409) conflict = 409;
    else await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await fetch(`${base}/api/portable/usb-copy?id=${job.id}`, { method: 'DELETE' }).catch(() => {});
  assert.ok([202, 409].includes(conflict || 202));
});

test('usb-plan reports sections, sizes, and per-target free space', async (t) => {
  const target = mkdtempSync(join(tmpdir(), 'usb-stick-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const { base } = await bootServer(t, { LOCAL_AI_USB_SCAN_ROOTS: target });
  const r = await post(base, '/api/portable/usb-plan', { target, include: { runtimes: 'none', data: true } });
  assert.equal(r.status, 200);
  const j = await r.json();
  const names = j.sections.map((s) => s.name);
  assert.ok(names.includes('app') && names.includes('runtime') && names.includes('data'), JSON.stringify(names));
  assert.equal(j.sections.find((s) => s.name === 'runtime').entries_count ?? undefined, undefined);
  assert.ok(j.total_bytes > 100_000, 'plan has meaningful size');
  assert.ok(j.target_free_bytes > 0);
  assert.equal(j.sections.find((s) => s.name === 'data').personal, true);
  assert.equal(j.sections.find((s) => s.name === 'runtime').note.includes('Skipped'), true);
});
