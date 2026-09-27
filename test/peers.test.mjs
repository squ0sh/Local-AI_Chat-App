import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { createServer as netCreateServer } from 'net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import http from 'http';

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

// ── Transport bus: USB bridge, frame reassembly, radio absence ──────────────
async function waitForInbox(base, want = 1, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const inbox = (await (await fetch(`${base}/api/peers`)).json()).inbox;
    if (inbox.length >= want) return inbox;
    await new Promise((r) => setTimeout(r, 150));
  }
  return [];
}

test('peers: bridge sneakernet — a dropped .capsule file becomes an inbox item', async (t) => {
  const bridgeA = mkdtempSync(join(tmpdir(), 'bridge-a-'));
  const bridgeB = mkdtempSync(join(tmpdir(), 'bridge-b-'));
  const a = await boot(t, { CAPSULE_BRIDGE_DIR: bridgeA });
  const b = await boot(t, { CAPSULE_BRIDGE_DIR: bridgeB });
  t.after(() => { for (const d of [bridgeA, bridgeB]) rmSync(d, { recursive: true, force: true }); });

  // the watch folder is live the moment the capsule answers /health
  for (let i = 0; i < 40; i += 1) {
    const tr = await (await fetch(`${b.base}/api/peers/transport`)).json();
    if (tr.transports.bridge.started) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // consent first, exactly as with every channel: pair cards both ways, then
  // the courier's drop is trusted. Without the pair the inbox refuses it.
  const cardTextA = (await (await fetch(`${a.base}/api/peers`)).json()).cardText;
  const cardTextB = (await (await fetch(`${b.base}/api/peers`)).json()).cardText;
  assert.equal((await post(b.base, '/api/peers/import-card', { text: cardTextA })).status, 200);
  assert.equal((await post(a.base, '/api/peers/import-card', { text: cardTextB })).status, 200);

  // export to a drop folder, then courier the file to the other capsule
  const exported = await post(a.base, '/api/peers/bridge/export', { items: [{ kind: 'note', title: 'Stick note', text: 'hand it over in person' }] });
  const j = await exported.json();
  if (exported.status !== 200) throw new Error(JSON.stringify(j));
  assert.equal(j.ok, true);
  assert.equal(j.written.length, 1);

  // move the file into B's incoming (a USB stick is copied the same way)
  mkdirSync(join(bridgeB, 'incoming'), { recursive: true });
  copyFileSync(j.written[0], join(bridgeB, 'incoming', 'drop.capsule'));

  const inbox = await waitForInbox(b.base);
  assert.equal(inbox.length, 1, JSON.stringify(inbox));
  assert.equal(inbox[0].via, 'bridge', 'the carrier labels the inbox row');
  assert.equal(inbox[0].item.text, 'hand it over in person');

  // the parsed file moved to processed/, so the watcher never double-feeds
  let processedCount = 0;
  try { processedCount = (await (await fetch(`${b.base}/api/peers/bridge`)).json()).processed; } catch {}
  assert.ok(processedCount >= 1);
});

test('peers: light frames — the transmit path yields self-describing TX frames, receive reassembles into the inbox', async (t) => {
  const { base } = await boot(t);
  const longText = 'off-grid note, just long enough to make the fragmenter split it over several ~180-byte frames. '.repeat(8);
  const made = await (await post(base, '/api/peers/' + 'postcard', { kind: 'note', title: 'M', text: longText })).json();
  assert.equal(made.ok, true, JSON.stringify(made));

  const frames = await (await post(base, '/api/peers/transport/frames', { text: made.text, maxBytes: 180 })).json();
  assert.ok(frames.count >= 2, 'a long postcard splits into multiple frames');
  assert.ok(frames.frames[0].startsWith('TX|'), 'frames are self-describing');

  // receiver pulls each frame apart and hands the reassembly job to /rx
  const sid = 'cap-test-sid';
  let completed = null;
  for (const raw of frames.frames) {
    const [h, seq, total, crc, data] = raw.split('|');
    assert.equal(h, 'TX');
    const r = await (await post(base, '/api/peers/transport/rx', { via: 'light', sid, seq: Number(seq), total: Number(total), crc, data })).json();
    if (r.complete) { completed = r; break; }
  }
  assert.ok(completed, 'the final rx call reports a full transfer');
  assert.equal(completed.textLen, made.text.length);

  const inbox = (await (await fetch(`${base}/api/peers`)).json()).inbox;
  const hit = inbox.find((i) => i.via === 'light');
  assert.ok(hit, 'the light carrier lands an inbox row through the same consent gate');
  assert.equal(hit.item.text, longText);
});

test('peers: radio renders available:false without hardware and never fakes a send', async (t) => {
  const { base } = await boot(t, {});
  const st = await (await fetch(`${base}/api/peers/transport`)).json();
  assert.equal(st.transports.radio.available, false, JSON.stringify(st.transports.radio));
  assert.ok(/dongle|CAPSULE_RADIO_CMD/.test(st.transports.radio.hint || ''));
  const sent = await post(base, '/api/peers/transport/radio', { text: 'hello radio' });
  assert.equal(sent.status, 409);
  // the transport status is comprehensive without being chatty
  for (const name of ['lan', 'bridge', 'light', 'sound', 'radio']) assert.ok(st.transports[name], name);
});

test('peers: transport status is loopback-only — a remote request sees 403', async (t) => {
  const { base, port } = await boot(t);
  // Simulate the public tunnel edge: the loopback fetch is re-labelled with a
  // Cloudflare IP + a public host, which fails isDirectLocalRequest on purpose.
  const res = await new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/api/peers/transport', headers: { Host: 'capsule.example.com', 'cf-connecting-ip': '198.51.100.7' } }, resolve);
    r.on('error', (e) => resolve({ statusCode: 0 }));
  });
  assert.equal(res.statusCode, 403);
  assert.ok(base.startsWith('http://127.0.0.1'));
});
