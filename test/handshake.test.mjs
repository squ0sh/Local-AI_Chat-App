import test from 'node:test';
import assert from 'node:assert/strict';
import { newDeviceIdentity, makeCard, readCard, packPostcard, unpackPostcard, envToText, textToEnv, wordsPhrase, fingerprint } from '../lib/capsule-handshake.mjs';
import { LanLink } from '../lib/capsule-net.mjs';

test('cards: self-signed card verifies; tampered cards are rejected', () => {
  const a = newDeviceIdentity();
  const card = makeCard(a, { name: 'Alice' });
  const read = readCard(card);
  assert.equal(read.name, 'Alice');
  assert.equal(read.fp, fingerprint(a.pub));
  const bad = { ...card, name: 'Mallory' }; // unsigned change
  assert.throws(() => readCard(bad), /signature/);
});

test('postcards: sealed mode end-to-end; open mode for ham; tamper & unknown-sender refusal', () => {
  const a = newDeviceIdentity(), b = newDeviceIdentity(), eve = newDeviceIdentity();
  const sealed = packPostcard(a, { kind: 'memory', mode: 'sealed', toDhPub: b.dhPub, item: { title: 'quiet plan', text: 'verify before move' } });
  const read = unpackPostcard(sealed, { identity: b, trustedPubs: [{ pub: a.pub }] });
  assert.equal(read.item.text, 'verify before move');
  assert.equal(read.sealed, true);
  assert.throws(() => unpackPostcard(sealed, { identity: eve, trustedPubs: [{ pub: a.pub }] }), null, 'wrong recipient key cannot read it');
  assert.throws(() => unpackPostcard(sealed, { identity: b, trustedPubs: [] }), /unknown sender/i, 'untrusted sender refused');
  const open = packPostcard(a, { kind: 'note', mode: 'open', item: { title: 'public', text: 'ham-legal' } });
  const ro = unpackPostcard(open, { trustedPubs: [{ pub: a.pub }] });
  assert.equal(ro.item.text, 'ham-legal');
  const forged = { ...open, sig: packPostcard(eve, { kind: 'note', mode: 'open', item: { title: 'x', text: 'x' } }).sig };
  assert.throws(() => unpackPostcard(forged, { trustedPubs: [{ pub: a.pub }] }), /signature invalid|unknown sender/);
});

test('fragments: shuffle, whitespace mangling, and missing-fragment detection', () => {
  const a = newDeviceIdentity(), b = newDeviceIdentity();
  const env = packPostcard(a, { kind: 'procedure', mode: 'sealed', toDhPub: b.dhPub, item: { name: 'n'.repeat(900), summary: 's'.repeat(200), steps: ['x'.repeat(150), 'y'.repeat(150), 'z'.repeat(150)] } });
  const frames = envToText(env, 90);
  assert.ok((frames.match(/CAPX1 /g) || []).length > 3, 'big payload really fragmented');
  const back = textToEnv(frames);
  assert.deepEqual(back.body, env.body);
  // Out-of-order reassembly
  const shuffled = frames.split(/(?=CAPX1 )/).reverse().join('\n');
  assert.deepEqual(textToEnv(shuffled).sig, env.sig);
  // Newline/tabs/CR interleaved — decoders stay calm
  const mangled = frames.split('\n').join('\r\n \t');
  assert.equal(textToEnv(mangled).kind, env.kind);
  // Missing fragment must throw
  const broken = frames.split(/(?=CAPX1 )/).slice(1).join('\n');
  assert.throws(() => textToEnv(broken), /missing fragment|no CAPX1/);
});

test('safety phrases: identical inputs make identical words', () => {
  const a = newDeviceIdentity();
  assert.equal(wordsPhrase(a.pub), wordsPhrase(a.pub));
  assert.equal(wordsPhrase(a.pub).split(' ').length, 6);
});

test('LAN link: handshake authenticates both sides; channel is encrypted; sessions close cleanly', async (t) => {
  const portA = 47401, portB = 47402;
  const A = new LanLink(newDeviceIdentity(), 'box A', { port: portA });
  const B = new LanLink(newDeviceIdentity(), 'box B', { port: portB });
  t.after(() => { A.stop(); B.stop(); });
  await A.listen();
  await B.listen();
  const sA = await A.connect('127.0.0.1', portB);
  await new Promise((r) => setTimeout(r, 250));
  const sB = [...B.sessions][0];
  assert.ok(sB, 'B accepted the session');
  assert.equal(sA.peer.fp, B.fingerprint());
  assert.equal(sB.peer.fp, A.fingerprint());
  assert.equal(sA.words, sB.words, 'safety words identical on both sides');
  const got = [];
  sB.onMessage((m) => got.push(m));
  sA.send({ t: 'hello', seq: 1 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(got[0]?.seq, 1);
  // Wrong-fingered forgery is refused during handshake
  const C = new LanLink(newDeviceIdentity(), 'mallory', { port: 47403 });
  t.after(() => C.stop());
  await C.listen();
  await assert.rejects(C.connect('127.0.0.1', portB, A.fingerprint()), /fingerprint/);
});
