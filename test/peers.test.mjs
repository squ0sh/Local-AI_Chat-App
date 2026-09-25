import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

const repoRoot = dirname(new URL('../server.mjs', import.meta.url).pathname);

function freePort() {
  return new Promise((resolve) => {
    const srv = netCreateServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function boot(t, extraEnv = {}) {
  const port = await freePort();
  const root = mkdtempSync(join(tmpdir(), 'peers-test-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ai_settings.env'), 'OPENAI_BASE_URL=http://127.0.0.1:9/v1\n');
  const server = spawn(process.execPath, ['server.mjs', '--mode', 'local', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, LOCAL_AI_DATA_DIR: dataDir, OLLAMA_URL: 'http://127.0.0.1:1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { server.kill(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(base + '/health'); if (r.status < 500) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { base, dataDir, port };
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('peers: card round-trip, postcard open-mode text, inbox approval gate', async (t) => {
  const { base } = await boot(t);
  const st = await (await fetch(`${base}/api/peers`)).json();
  assert.ok(st.fp && st.words.split(' ').length === 6);
  assert.ok(st.cardText.includes('CAPX1 cardref'), 'card exports as frames');

  // postcard: open note to the world
  const made = await (await post(base, '/api/peers/postcard', { kind: 'note', title: 'Trail update', text: 'Meet at the ridge at noon' })).json();
  assert.equal(made.ok, true);
  assert.equal(made.mode, 'open');
  assert.ok(made.text.includes('CAPX1 note'));

  // import own postcard (from the same box — self, like a same-station relay)
  const back = await (await post(base, '/api/peers/import', { text: made.text })).json();
  assert.equal(back.ok, true);
  assert.equal(back.inbox.kind, 'note');

  // accept gates the inbox
  const q = (await (await fetch(`${base}/api/peers`)).json()).inbox;
  assert.equal(q.length, 1);
  const ok = await post(base, '/api/peers/inbox/decide', { id: q[0].id, action: 'accept' });
  assert.equal(ok.status, 200);
  assert.equal((await (await fetch(`${base}/api/peers`)).json()).inbox.length, 0);
});

test('peers: unknown sender frames are refused cleanly; mangled text rejected', async (t) => {
  const { base } = await boot(t);
  const gibberish = await post(base, '/api/peers/import', { text: 'CAPX1 note deadbeefcafe frag1of2 sigxyz len10\n0123456789' });
  assert.equal(gibberish.status, 400);
  const junk = await post(base, '/api/peers/import', { text: 'hello there this is not a postcard' });
  assert.equal(junk.status, 400);
});

test('peers: two live servers handshake over LAN — pushed items land in the peer inbox', async (t) => {
  const a = await boot(t, { LOCAL_AI_PEER_PORT: 48501 });
  const b = await boot(t, { LOCAL_AI_PEER_PORT: 48502 });
  await post(a.base, '/api/peers/listen', { on: true });
  await post(b.base, '/api/peers/listen', { on: true });
  // consent gate first: pushing to an UNTRUSTED capsule must be refused
  const denied = await post(a.base, '/api/peers/sync', { address: '127.0.0.1', port: 48502, items: [{ kind: 'note', title: 'x', text: 'x' }] });
  assert.notEqual(denied.status, 200, 'untrusted peer is refused');
  // pair BOTH cards (handshakes are mutual), then the same push must land
  const cardTextA = (await (await fetch(`${a.base}/api/peers`)).json()).cardText;
  const cardTextB = (await (await fetch(`${b.base}/api/peers`)).json()).cardText;
  assert.equal((await post(b.base, '/api/peers/import-card', { text: cardTextA })).status, 200);
  assert.equal((await post(a.base, '/api/peers/import-card', { text: cardTextB })).status, 200);
  const sync = await post(b.base, '/api/peers/sync', { address: '127.0.0.1', port: 48501, items: [{ kind: 'note', title: 'LAN hello', text: 'hand-delivered' }] });
  assert.equal(sync.status, 200);
  const syncJ = await sync.json();
  assert.equal(syncJ.ok, true);
  assert.ok(syncJ.words.split(' ').length === 6);
  // poll A's inbox until the item shows (session is near-instant on loopback)
  let inbox = [];
  for (let i = 0; i < 30; i += 1) {
    inbox = (await (await fetch(`${a.base}/api/peers`)).json()).inbox;
    if (inbox.length) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].item.text, 'hand-delivered');
  assert.equal(inbox[0].via, 'lan');
});
