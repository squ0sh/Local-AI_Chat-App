import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, fragment, defragment, envelopeFrame, unenvelopeFrame, TransportBus } from '../lib/peer-transport.mjs';

test('crc32 matches the standard IEEE vector', () => {
  assert.equal(crc32('123456789').toString(16), 'cbf43926');
});

test('fragment/defragment round-trips at every boundary size', () => {
  const sizes = [0, 1, 16, 63, 64, 65, 900, 901, 9000, 64 * 1024];
  for (const size of sizes) {
    const text = 'p'.repeat(size);
    const chunks = fragment(text, 900);
    assert.ok(chunks.length === Math.max(1, Math.ceil(Math.max(1, size) / 900)), `size ${size}`);
    assert.equal(defragment(chunks), text);
  }
});

test('defragment rebuilds even when fragments arrive out of order', () => {
  const text = 'x'.repeat(5000);
  const chunks = fragment(text, 900).reverse();
  assert.equal(defragment(chunks), text);
});

test('defragment refuses tampered, duplicated, missing, or bad-index bundles', () => {
  const chunks = fragment('trust me', 900);
  assert.throws(() => defragment(chunks.map((c, i) => (i === 0 ? { ...c, data: Buffer.from('evil').toString('base64') } : c))), /checksum/);
  assert.throws(() => defragment([...chunks, chunks[0]]), /duplicate/);
  assert.throws(() => defragment(chunks.slice(1)), /incomplete/);
  assert.throws(() => defragment([{ ...chunks[0], seq: 99 }]), /out of range/);
  const three = fragment('x'.repeat(2000), 900);
  assert.throws(() => defragment([...three, three[1]]), /duplicate/);
});

test('envelope frame: single-line wrapper round-trips and rejects tampering', () => {
  const text = 'CAPX1 note frag1of1 sigabc len12\nhello world';
  const frame = envelopeFrame(text);
  assert.ok(frame.startsWith('CPX1 '));
  assert.equal(unenvelopeFrame(frame), text);
  assert.throws(() => unenvelopeFrame(frame.replace(/l=\d+/, 'l=1')), /length mismatch/);
  assert.throws(() => unenvelopeFrame(frame.replace(/c=[0-9a-f]+/, 'c=deadbeef')), /checksum/);
  assert.throws(() => unenvelopeFrame('bogus'), /not a capsule/);
});

test('bus: register, deliver lands on the single consent seam, status shape', async () => {
  const ingested = [];
  const bus = new TransportBus({ onIngest: (text, name) => ingested.push([text, name]) });
  const bridge = {
    name: 'bridge', offline: true, uplink: true, downlink: true,
    status: () => ({ path: '/tmp/in' }),
    start: async () => {}, stop: async () => {},
    send: async () => 'ok',
  };
  bus.register(bridge);
  const naive = { name: 'light', offline: true, uplink: true, downlink: true, status: () => ({}) };
  bus.register(naive);
  assert.throws(() => bus.register(naive), /duplicate/);
  await bus.start('bridge');
  bus.deliver('CAPX1 note frag1of1 sigx len2\nhi', 'bridge');
  assert.deepEqual(ingested, [['CAPX1 note frag1of1 sigx len2\nhi', 'bridge']]);
  assert.equal(ingested[0][1], 'bridge');
  const st = bus.status();
  assert.ok(st.bridge.offline === true && st.light.offline === true);
  assert.ok(st.bridge._counters.inbox === 1);
  assert.equal(await bus.send('bridge', {}), 'ok');
  await bus.stop('bridge');
  assert.equal(bus.status().bridge.started, false);
});

test('bus: unknown transport fails loudly, never silently', async () => {
  const bus = new TransportBus();
  await assert.rejects(() => bus.start('nope'), /unknown transport/);
  assert.throws(() => bus.send('nope', {}), /no sendable transport/);
});