import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { MemoryStore, makeStubEmbedder, chunkText } from '../lib/capsule-memory.mjs';

const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);

function freePort() {
  return new Promise((resolve) => {
    const srv = netCreateServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function boot(t, extraEnv = {}) {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'mem-test-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ai_settings.env'), 'OPENAI_BASE_URL=http://127.0.0.1:9/v1\n');
  const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, LOCAL_AI_DATA_DIR: dataDir, OLLAMA_URL: 'http://127.0.0.1:1', LOCAL_AI_EMBED_STUB: '1', ...extraEnv },
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

// ── Store unit tests ─────────────────────────────────────────────────────────

test('memory store: encrypted at rest; plaintext recoverable only in-process', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memstore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = makeStubEmbedder();
  const s = new MemoryStore(dir);
  s.load();
  await s.syncSource({ type: 'chat', id: 'c1', title: 'npm talk' }, ['A long enough chunk about updating npm dependencies one at a time so nothing ever breaks badly.'], stub);
  s.save();
  const onDisk = readFileSync(join(dir, 'memory-store.json.enc'));
  assert.ok(!onDisk.includes('dependencies'), 'cipher on disk, not plaintext');
  const s2 = new MemoryStore(dir);
  assert.equal(s2.load(), 1, 'reload survives encryption');
});

test('memory store: hash-diffing re-embeds only changed chunks', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memstore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let embedCalls = 0;
  const counting = { model: 'stub', available: async () => true, embed: async (texts) => { embedCalls += Array.isArray(texts) ? texts.length : 1; return makeStubEmbedder().embed(texts); } };
  const s = new MemoryStore(dir);
  const src = { type: 'chat', id: 'c1', title: 't' };
  await s.syncSource(src, ['Alpha text long enough to pass the minimum chunk size gate comfortably.'], counting);
  await s.syncSource(src, ['Alpha text long enough to pass the minimum chunk size gate comfortably.'], counting);
  assert.equal(embedCalls, 1, 'identical content is not re-embedded');
  await s.syncSource(src, ['Beta text long enough to pass the minimum chunk size gate comfortably.'], counting);
  assert.equal(embedCalls, 2, 'changed content reindexes exactly one chunk');
});

test('memory store: semantic ranking puts the right source first; keyword fallback works', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memstore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = makeStubEmbedder();
  const s = new MemoryStore(dir);
  await s.syncSource({ type: 'chat', id: 'deps', title: 'deps chat' }, ['How to update npm dependencies safely in one controlled motion with tests between steps.'], stub);
  await s.syncSource({ type: 'chat', id: 'pie', title: 'pie chat' }, ['Grandma pie recipe with cinnamon apples and patience for the oven warmth and crust.'], stub);
  const semantic = s.search('update dependencies safely', (await stub.embed(['update dependencies safely']))[0], 3);
  assert.equal(semantic[0].chunk.srcId, 'deps');
  assert.ok(semantic[0].score > semantic[semantic.length - 1].score);
  const keyword = s.search('npm update ritual', null, 3);
  assert.equal(keyword[0].chunk.srcId, 'deps');
});

test('memory store: purge crypto-shreds (key gone, index unreadable)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memstore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = new MemoryStore(dir);
  await s.syncSource({ type: 'chat', id: 'c1', title: 't' }, ['Secret plans that should vanish without any recoverable trace whatsoever from here.'], makeStubEmbedder());
  s.save();
  s.purge();
  assert.equal(existsSync(join(dir, 'memory-store.json.enc')), false);
  assert.equal(existsSync(join(dir, 'memory.key')), false);
  const fresh = new MemoryStore(dir);
  assert.equal(fresh.load(), 0);
});

test('chunkText emits citation-shaped chunks only for material content', () => {
  const chunks = chunkText('short', { type: 'chat', id: 'c1', title: 'x' });
  assert.equal(chunks.length, 0, 'trivial content is not indexed');
  const big = 'Sentence one of roast settings. '.repeat(120);
  const parts = chunkText(big, { type: 'chat', id: 'c9', title: 'roast' });
  assert.ok(parts.length >= 2);
  assert.equal(parts[0].id, 'chat:c9:0');
  assert.equal(parts[0].srcId, 'c9');
  assert.equal(parts[0].type, 'chat');
  assert.equal(parts[1].id, 'chat:c9:1');
});

// ── Server-level: enable → index → search with citations ────────────────────

test('memory API: toggle on, chats index on save, search cites the source chat', async (t) => {
  const { base } = await boot(t);
  const off = await (await fetch(`${base}/api/memory/status`)).json();
  assert.equal(off.enabled, false);
  assert.equal(off.mode, 'off');

  await (await fetch(`${base}/api/memory/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' })).json();

  const chatId = 'chat-probe-1';
  await (await fetch(`${base}/api/chatstate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: { chats: [{ id: chatId, title: 'Router choices', createdAt: 1, updatedAt: 2, model: '', systemPrompt: '', projectId: '', privacy: 'local', messages: [{ role: 'user', content: 'How should we route free models?' }, { role: 'assistant', content: 'Pick the fallback chain carefully, starting with the fastest provider and failing over to quality.' }] }], projects: [], activeId: chatId } }),
  })).json();

  const re = await (await fetch(`${base}/api/memory/reindex`, { method: 'POST' })).json();
  assert.ok(re.sources >= 1 && re.reindexed >= 1, JSON.stringify(re));

  const st = await (await fetch(`${base}/api/memory/status`)).json();
  assert.equal(st.enabled, true);
  assert.equal(st.mode, 'semantic', 'stub embedder gives semantic mode in tests');

  const sr = await (await fetch(`${base}/api/memory/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'fallback chain choice' }) })).json();
  const top = sr.results[0];
  assert.ok(top, 'recall found the indexed chat');
  assert.equal(top.chat_id, chatId);
  assert.equal(top.title, 'Router choices');

  const purge = await (await fetch(`${base}/api/memory/purge`, { method: 'POST' })).json();
  assert.equal(purge.purged, true);
  const st2 = await (await fetch(`${base}/api/memory/status`)).json();
  assert.equal(st2.enabled, false);
  assert.equal(st2.chunks, 0);
});

// ── The privacy contract: memory must never ride cloud payloads ─────────────

test('privacy contract: memory injection lives strictly inside the local-only chat branch', () => {
  const src = readFileSync(join(repoRoot, 'server.mjs'), 'utf8');
  const chatFn = src.slice(src.indexOf('async function streamChat'));
  const localBranch = chatFn.indexOf("provider === 'ollama' && payload.mode !== 'cloud'");
  const memoryUse = chatFn.indexOf('memoryContextBlock(');
  assert.ok(localBranch > 0 && memoryUse > localBranch, 'memoryContextBlock is only reachable from the local branch');
});
