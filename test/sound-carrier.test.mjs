import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, decodeAll, decoderText, SAMPLE_RATE } from '../lib/vendor/sound-modem.mjs';
import { bootServer } from './helpers/server-harness.mjs';

const boot = bootServer;
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('sound carrier: a transport frame survives speaker→mic roundtrip', () => {
  const frame = 'TX|1|2|5c1d2f|postcard over sound, no wifi needed';
  const snd = encode(frame);
  assert.ok(snd.length > 0);
  const out = decode(snd);
  assert.ok(out, 'the modem recovers a packet from the samples');
  assert.equal(decoderText(out), frame);
});

test('sound carrier: decoder is robust to volume, noise, and mic jitter', () => {
  const frame = 'TX|0|3|abc123|hello off-grid';
  const snd = encode(frame);
  assert.equal(decoderText(decode(snd.map((v) => v * 0.15))), frame, 'quiet speaker still decodes');
  assert.equal(decoderText(decode(snd.map((v) => v + (Math.random() - 0.5) * 0.4))), frame, 'noisy room still decodes');
  const delayed = new Float32Array(137 + snd.length);
  delayed.set(snd, 137);
  assert.equal(decoderText(decode(delayed)), frame, 'mic latency is found by the phase search');
  const resampled = new Float32Array(Math.floor((44100 / 48000) * snd.length));
  for (let i = 0; i < resampled.length; i += 1) {
    const f = i / (44100 / 48000);
    const lo = Math.floor(f);
    const hi = Math.min(lo + 1, snd.length - 1);
    resampled[i] = snd[lo] + (snd[hi] - snd[lo]) * (f - lo);
  }
  assert.equal(decoderText(decode(resampled, { sampleRate: 44100 })), frame, '44.1 kHz mic input is resampled');
});

test('sound carrier: back-to-back bursts each decode as separate packets', () => {
  const a = encode('FRAME#0');
  const b = encode('FRAME#1');
  const gap = new Float32Array(1200).fill(0);
  const all = new Float32Array(a.length + gap.length + b.length);
  all.set(a, 0);
  all.set(gap, a.length);
  all.set(b, a.length + gap.length);
  const packets = decodeAll(all).map((p) => decoderText(p));
  assert.ok(packets.includes('FRAME#0') && packets.includes('FRAME#1'), JSON.stringify(packets));
});

test('sound carrier: the largest transport frame payload fits one burst', () => {
  const payload = 'payload.'.repeat(220);
  const snd = encode(payload);
  const out = decode(snd);
  assert.ok(out, 'the burst survives');
  assert.equal(decoderText(out), payload);
});

test('sound carrier: postcard → sound → /api/peers/transport/rx → inbox (via "sound")', async (t) => {
  const { base } = await boot(t);
  const text = 'handed over by sound, kept off the network. '.repeat(14);
  const made = await (await post(base, '/api/peers/' + 'postcard', { kind: 'note', title: 'S', text })).json();
  assert.equal(made.ok, true, JSON.stringify(made));

  const frames = await (await post(base, '/api/peers/transport/frames', { text: made.text, maxBytes: 180 })).json();
  assert.ok(frames.count >= 2);

  let completed = null;
  for (const raw of frames.frames) {
    const decoded = decoderText(decode(encode(raw)));
    assert.equal(decoded, raw, 'no corruption through the speaker→mic path');
    const [h, seq, total, crc, data] = decoded.split('|');
    assert.equal(h, 'TX');
    const r = await (await post(base, '/api/peers/transport/rx', { via: 'sound', sid: 'sound-chain', seq: Number(seq), total: Number(total), crc, data })).json();
    if (r.complete) { completed = r; break; }
  }
  assert.ok(completed, 'the final sound burst completes the transfer');
  assert.equal(completed.textLen, made.text.length);

  const inbox = (await (await fetch(`${base}/api/peers`)).json()).inbox;
  const hit = inbox.find((i) => i.via === 'sound');
  assert.ok(hit, 'the sound-decoded postcard lands in the inbox');
  assert.equal(hit.item.text, text);
});

test('sound carrier: the modem is served for the browser receive page', async (t) => {
  const { base } = await boot(t);
  const r = await fetch(`${base}/sound-modem.js`);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('SoundModem'), 'the UMD build exposes the browser global');
});

test('sound carrier: decodeAll rejects a buffer with no packets', () => {
  const noise = Float32Array.from({ length: 48000 }, () => Math.random() * 2 - 1);
  assert.equal(decode(noise), null);
  assert.equal(decodeAll(noise).length, 0);
});

test('sound carrier: encode/decode sample length scales with payload', () => {
  const short = encode('hi');
  const long = encode('X'.repeat(400));
  assert.ok(long.length > short.length);
  assert.equal(SAMPLE_RATE, 48000);
});