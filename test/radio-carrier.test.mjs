import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootServer } from './helpers/server-harness.mjs';

const boot = bootServer;
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// A mock LoRa dongle pair, implemented as shell scripts over two spools —
// exactly the shape of a real `meshtastic --sendtext` + `meshtastic --listen`
// relay, minus the radio. Each capsule owns a spool; transmit appends a frame
// to your own spool; the other capsule's listener pulls from that spool, the
// way an antenna couples one radio to the next. No capsule ever pulls from its
// own transmissions — over the air, outgoing frames are gone once sent.
function fakeRadioPair() {
  const root = mkdtempSync(join(tmpdir(), 'capsule-radio-'));
  const air = join(root, 'air');      // frames A puts on the air
  const own = join(root, 'own');      // B's spool (stays quiet, like TX-only air)
  for (const dir of [air, own]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'queue.txt'), '');
  }
  const send = join(root, 'radio-send.sh');
  const recv = join(root, 'radio-recv.sh');
  writeFileSync(send, [
    '#!/bin/bash',
    'printf "%s\\n" "$1" >> "$RADIO_SPOOL/queue.txt"',
    '',
  ].join('\n'));
  writeFileSync(recv, [
    '#!/bin/bash',
    'if [ -s "$AIR_SPOOL/queue.txt" ]; then',
    '  IFS= read -r line < <(head -1 "$AIR_SPOOL/queue.txt")',
    '  tail -n +2 "$AIR_SPOOL/queue.txt" > "$AIR_SPOOL/queue.tmp" && mv "$AIR_SPOOL/queue.tmp" "$AIR_SPOOL/queue.txt"',
    '  printf "%s\\n" "$line"',
    'fi',
    '',
  ].join('\n'));
  chmodSync(send, 0o755);
  chmodSync(recv, 0o755);
  return { root, air, own, send, recv };
}

test('radio carrier: postcard frames flow through a real dongle-shaped CLI and land via "radio"', async (t) => {
  const pair = fakeRadioPair();
  const aEnv = {
    CAPSULE_RADIO_CMD: pair.send + ' %T',
    RADIO_SPOOL: pair.air,
  };
  const bEnv = {
    CAPSULE_RADIO_CMD: pair.send + ' %T',
    CAPSULE_RADIO_RECEIVE_CMD: pair.recv,
    CAPSULE_RADIO_POLL_MS: '250',
    RADIO_SPOOL: pair.own,
    AIR_SPOOL: pair.air,
  };

  const a = await boot(t, { extraEnv: aEnv });
  const b = await boot(t, { extraEnv: bEnv });

  // consent first — the radio is just another courier, cards still pair people
  const cardA = (await (await fetch(`${a.base}/api/peers`)).json()).cardText;
  const cardB = (await (await fetch(`${b.base}/api/peers`)).json()).cardText;
  assert.equal((await post(b.base, '/api/peers/import-card', { text: cardA })).status, 200);
  assert.equal((await post(a.base, '/api/peers/import-card', { text: cardB })).status, 200);

  // both capsules see hardware this time
  const st = await (await fetch(`${a.base}/api/peers/transport`)).json();
  assert.equal(st.transports.radio.available, true, JSON.stringify(st.transports.radio));
  assert.equal(st.transports.radio.mode, 'custom');

  const text = 'one capsule, speaking radio directly to another. offline all the way. '.repeat(6);
  // like the bridge card, radio rides postcard envelopes — make one, send it
  const made = await post(a.base, '/api/peers/postcard', { kind: 'note', text });
  if (made.status !== 200) throw new Error('postcard: ' + await made.text());
  const { text: madeText } = await made.json();
  const sent = await post(a.base, '/api/peers/transport/radio', { text: madeText, maxBytes: 700 });
  const sj = await sent.json();
  if (sent.status !== 200) throw new Error(JSON.stringify(sj));
  assert.ok(sj.sent >= 1, 'frames were transmitted through the fake dongle');
  assert.ok(sj.sent >= 2, 'a wordy postcard fragments over several transmissions');

  // the receiving capsule polled its dongle and ran the same consent gate
  // (polls floor at 500ms, so two fragments need ~2s — wait generously)
  let inbox = [];
  for (let i = 0; i < 80; i += 1) {
    inbox = (await (await fetch(`${b.base}/api/peers`)).json()).inbox;
    if (inbox.find((it) => it.via === 'radio')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const hit = inbox.find((it) => it.via === 'radio');
  assert.ok(hit, 'the radio-delivered postcard lands in the inbox');
  assert.equal(hit.item.text, text, 'every frame reassembled without loss');
  // the fake dongle drained its queue: no frame is delivered twice
  assert.equal(hit.item.text.length, text.length);
});

test('radio carrier: an empty spool yields no deliveries', async (t) => {
  const pair = fakeRadioPair();
  const b = await boot(t, {
    extraEnv: {
      CAPSULE_RADIO_CMD: pair.send + ' %T',
      CAPSULE_RADIO_RECEIVE_CMD: pair.recv,
      CAPSULE_RADIO_POLL_MS: '200',
      RADIO_SPOOL: pair.own,
      AIR_SPOOL: pair.air, // silent wire: nothing was ever transmitted
    },
  });
  await new Promise((r) => setTimeout(r, 900));
  const inbox = (await (await fetch(`${b.base}/api/peers`)).json()).inbox;
  assert.equal(inbox.length, 0, 'silence on the air stays silence in the inbox');
});