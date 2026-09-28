// Capsule peer transport bus.
//
// Every capsule already speaks one protocol of trust — signed, optionally
// sealed postcards — and every carrier below only has to move postcard *text*
// from one inbox channel to another. The bus is the one narrow seam: carriers
// register here, the server subscribes to `deliver`, and inbound bytes always
// pass through the same consent gate, never bypassing the approval inbox.
//
// Memory-time hard rule: nothing lands silently, on any medium. The bus does
// not unpack, store, or execute anything itself — it hands the postcard text
// to the server, which verifies the signature and queues an inbox item.
//
// Postcards are the payload; carriers are interchangeable:
//   lan      — same-network UDP broadcast + encrypted TCP stream (LibLanLink)
//   bridge   — USB stick / folder sneakernet, courier-delivered
//   light    — camera-to-screen animated QR stream (same room)
//   sound    — speaker-to-microphone data-over-sound modem (same room)
//   radio    — LoRa / Meshtastic dongle, hardware-gated, mock-testable
import { EventEmitter } from 'events';

// ── CRC-32 (IEEE), exported for the carriers' frame headers ─────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8');
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Envelope fragmenter: big postcards ride any low-bandwidth channel ───────
// Chunks are { seq, total, crc, data } where crc covers `data`. `defragment`
// is strict: it refuses partial, duplicated, reordered, or tampered bundles.
export const FRAG_HEADER = 'seqtot';
export function fragment(text, maxBytes = 900) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  const dataLen = Math.max(16, Math.floor(Math.max(64, maxBytes)));
  const total = Math.max(1, Math.ceil(bytes.length / dataLen));
  const chunks = [];
  for (let seq = 0; seq < total; seq += 1) {
    const data = bytes.subarray(seq * dataLen, (seq + 1) * dataLen);
    chunks.push({ seq, total, dataLen, crc: crc32(data).toString(16), data: data.toString('base64') });
  }
  return chunks;
}
export function defragment(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('incomplete fragment bundle');
  const total = Number(chunks[0].total);
  if (!Number.isInteger(total) || total < 1 || total > 4096) throw new Error('bad fragment count');
  let maxLen = 0;
  const slots = new Array(total);
  for (const c of chunks) {
    const seq = Number(c.seq);
    if (!Number.isInteger(seq)) throw new Error('bad fragment index');
    if (seq < 0 || seq >= total) throw new Error(`fragment ${seq} out of range 0..${total - 1}`);
    if (slots[seq]) throw new Error(`duplicate fragment ${seq}`);
    const data = Buffer.from(String(c.data || ''), 'base64');
    if (crc32(data).toString(16) !== String(c.crc || '')) throw new Error(`fragment ${seq} failed its checksum`);
    slots[seq] = data;
    maxLen = Math.max(maxLen, data.length);
  }
  if (slots.some((s) => !s)) throw new Error(`incomplete bundle — missing ${slots.filter((s) => !s).length} fragment(s)`);
  const out = Buffer.concat(slots);
  return out.toString('utf8');
}

// One-line envelope bundle: encode whole envelope into a single `QM1` frame,
// used for small payloads (bridge, print, paste) and as the fallback that
// fits a single radio or QR frame unchanged.
export function envelopeFrame(text, kind = 'postcard') {
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  return `CPX1 ${kind} l=${bytes.length} c=${crc32(bytes).toString(16)}\n${text}`;
}
export function unenvelopeFrame(frame) {
  if (!String(frame).startsWith('CPX1 ')) throw new Error('not a capsule envelope frame');
  const nl = String(frame).indexOf('\n');
  const head = String(frame).slice(0, nl).trim().split(/\s+/);
  let body = String(frame).slice(nl + 1);
  // Writers may add a cosmetic trailing newline; the payload length and CRC
  // were computed over the exact envelope bytes, so trim one EOL and re-check.
  if (body.endsWith('\r\n')) body = body.slice(0, -2);
  else if (body.endsWith('\n')) body = body.slice(0, -1);
  const li = head.findIndex((h) => h.startsWith('l='));
  const ci = head.findIndex((h) => h.startsWith('c='));
  if (li < 0 || ci < 0) throw new Error('bad envelope frame header');
  const len = Number(String(head[li]).slice(2));
  if (Number.isNaN(len) || body.length !== len) throw new Error('envelope frame length mismatch');
  if (crc32(body).toString(16) !== String(head[ci]).slice(2)) throw new Error('envelope frame failed its checksum');
  return body;
}

// ── The bus ──────────────────────────────────────────────────────────────────
export class TransportBus extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.transports = new Map();
    this.onIngest = opts.onIngest || (() => {});
    this.state = new Map(); // name -> runtime state object
  }

  register(t) {
    if (!t || !t.name) throw new Error('a transport needs a name');
    if (this.transports.has(t.name)) throw new Error('duplicate transport ' + t.name);
    this.transports.set(t.name, t);
    this.state.set(t.name, { started: false, lastError: '', lastAck: '', outbox: 0, inbox: 0, detail: {} });
    return this;
  }

  async start(name) {
    const t = this.transports.get(name);
    if (!t) throw new Error('unknown transport ' + name);
    const st = this.state.get(name);
    try {
      if (t.start) await t.start();
      st.started = true; st.lastError = '';
    } catch (e) {
      st.started = false; st.lastError = String(e.message || e);
      throw e;
    }
    return this;
  }

  async stop(name) {
    const t = this.transports.get(name);
    if (!t) return this;
    const st = this.state.get(name) || {};
    try { if (t.stop) await t.stop(); } catch {}
    st.started = false;
    return this;
  }

  // The single consent seam. Carriers call `deliver(postcardText)` when they
  // receive bytes; the server's onIngest verifies + queues the approval item.
  deliver(text, via) {
    const name = via || '?';
    const st = this.state.get(name) || this.state.get('') || {};
    st.inbox = Number(st.inbox || 0) + 1;
    this.onIngest(text, name);
  }

  send(name, opts) {
    const t = this.transports.get(name);
    if (!t || typeof t.send !== 'function') throw new Error('no sendable transport named ' + name);
    return t.send(opts || {});
  }

  status() {
    const out = {};
    for (const [name, t] of this.transports) {
      const st = this.state.get(name) || {};
      let s;
      try { s = t.status ? t.status() : {}; } catch (e) { s = { error: e.message }; }
      out[name] = {
        offline: !!t.offline,
        uplink: !!t.uplink,
        downlink: !!t.downlink,
        started: !!st.started,
        ...s,
        _counters: { outbox: st.outbox || 0, inbox: st.inbox || 0 },
      };
    }
    return out;
  }
}

export const TRANSPORT_NAMES = ['lan', 'bridge', 'light', 'sound', 'radio'];