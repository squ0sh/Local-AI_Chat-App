import test from 'node:test';
import assert from 'node:assert/strict';
import qrcode from '../lib/vendor/qrcode-generator.mjs';
import jsQR from '../lib/vendor/jsqr.mjs';
import { bootServer } from './helpers/server-harness.mjs';

const boot = bootServer;
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Render QR text into RGBA pixels the way a lit screen looks to a camera:
// white background, black modules, scaled so a phone lens can actually read it.
function qrToRGBA(text, cell = 5, quiet = 4) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + quiet * 2) * cell;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!qr.isDark(r, c)) continue;
      for (let dy = 0; dy < cell; dy += 1) {
        for (let dx = 0; dx < cell; dx += 1) {
          const x = (quiet + c) * cell + dx;
          const y = (quiet + r) * cell + dy;
          const i = (y * size + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  return { px, size };
}

test('qr carrier: a frame string survives encode→decode on the first try', () => {
  const text = 'TX|0|3|ab12c3|hello off-grid frame number one';
  const frame = qrToRGBA(text, 5);
  const res = jsQR(frame.px, frame.size, frame.size);
  assert.ok(res, 'the decoder finds and reads the code');
  assert.equal(res.data, text);
});

test('qr carrier: the decoder reads the largest transport frame payload', () => {
  // transportFrames caps frames because QR version 1-40 hold ~300-3000 bytes;
  // this exercises a dense multi-error-correction-block code (version ~20).
  const text = 'TX|5|9|feed1c01|' + 'payload.'.repeat(190);
  const frame = qrToRGBA(text, 7);
  const res = jsQR(frame.px, frame.size, frame.size);
  assert.ok(res, 'the decoder reads a busy frame');
  assert.equal(res.data, text);
});

test('qr carrier: postcard → frames → on-screen QR → camera decode → inbox (via "light")', async (t) => {
  const { base } = await boot(t);
  const text = 'seen by a camera, not by wifi. '.repeat(14);
  const made = await (await post(base, '/api/peers/' + 'postcard', { kind: 'note', title: 'L', text })).json();
  assert.equal(made.ok, true, JSON.stringify(made));

  const frames = await (await post(base, '/api/peers/transport/frames', { text: made.text, maxBytes: 180 })).json();
  assert.ok(frames.count >= 2);

  // the recipient's phone shows each frame on-screen → its camera decodes it
  let completed = null;
  for (const raw of frames.frames) {
    const encoded = qrToRGBA(raw, 7);
    const decoded = jsQR(encoded.px, encoded.size, encoded.size);
    assert.ok(decoded, 'receive page decodes the on-screen frame');
    assert.equal(decoded.data, raw, 'no corruption through the light path');
    const [h, seq, total, crc, data] = decoded.data.split('|');
    assert.equal(h, 'TX');
    const r = await (await post(base, '/api/peers/transport/rx', { via: 'light', sid: 'qr-chain', seq: Number(seq), total: Number(total), crc, data })).json();
    if (r.complete) { completed = r; break; }
  }
  assert.ok(completed, 'the final decoded frame completes the transfer');
  assert.equal(completed.textLen, made.text.length);

  const inbox = (await (await fetch(`${base}/api/peers`)).json()).inbox;
  const hit = inbox.find((i) => i.via === 'light');
  assert.ok(hit, 'the camera-decoded postcard lands in the inbox');
  assert.equal(hit.item.text, text);
});

test('qr carrier: /jsqr.js is served for the browser receive page', async (t) => {
  const { base } = await boot(t);
  const r = await fetch(`${base}/jsqr.js`);
  assert.equal(r.status, 200);
  const js = await r.text();
  assert.ok(js.includes('webpackUniversalModuleDefinition'), 'the UMD build is served raw');
});

test('qr carrier: /api/peers/transport/qr renders a frame as SVG for the transmit page', async (t) => {
  const { base } = await boot(t);
  const r = await fetch(`${base}/api/peers/transport/qr?text=${encodeURIComponent('TX|1|1|00|hi')}`);
  assert.equal(r.status, 200);
  const svg = await r.text();
  assert.ok(svg.startsWith('<svg'), 'server-side QR is an SVG the page can <img>');
});