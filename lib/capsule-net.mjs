// Capsule LAN pairing: UDP announce/discovery + an authenticated, encrypted
// TCP sync channel using only Node built-ins:
//
//   hello   (X25519 ephemeral + Ed25519 signature, both directions)
//   keys    = sha256(ECDH) → AES-256-GCM, one direction-bound key per side
//   words   — both parties see the same derived 6-word phrase to read aloud
//
// Items ride as a manifest OFFER → WANT(ids) → ITEM … → DONE. Anything a side
// doesn't want is never transferred: consent is in the protocol, not the prose.
import { createSocket } from 'dgram';
import { createServer, createConnection } from 'net';
import { generateKeyPairSync, diffieHellman, createHash, randomBytes, createCipheriv, createDecipheriv, createPublicKey, createPrivateKey, sign, verify } from 'crypto';
import { EventEmitter } from 'events';

export const LAN_PORT = 45917;

const frame = (obj) => { const b = Buffer.from(JSON.stringify(obj)); const len = Buffer.alloc(4); len.writeUInt32BE(b.length, 0); return Buffer.concat([len, b]); };
function deframer(onMsg) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > 4 * 1024 * 1024) throw new Error('oversized frame');
      if (buf.length < 4 + len) return;
      onMsg(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
      buf = buf.subarray(4 + len);
    }
  };
}

const ephKeys = () => generateKeyPairSync('x25519');
const dhPubB64 = (k) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const signBytes = (privB64, bytes) => sign(null, bytes, createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64');
const verifyBytes = (pubB64, bytes, sig) => { try { return verify(null, bytes, createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' }), Buffer.from(sig, 'base64')); } catch { return false; } };
const WORDS = 'amber atlas beacon birch bloom cedar cliff comet coral delta ember fern flint frost garnet globe harbor hazel hollow indigo ivory jade juniper kelp lagoon lark linen lotus lumen maple meadow mesa mistral mosaic nimbus north olive onyx orchid otter pebble pine plume quartz raven reef river saffron sage sandal shadow silver solar sonnet sparrow spring summit talc thistle timber tundra umber velvet violet walnut willow winter zephyr'.split(' ');
const sessionWords = (secret) => { const h = createHash('sha256').update('pair:' + secret.toString('base64')).digest(); return Array.from({ length: 6 }, (_, i) => WORDS[h[i] % WORDS.length]).join(' '); };

export class LanLink extends EventEmitter {
  constructor(identity, label, opts = {}) {
    super();
    this.port = opts.port || LAN_PORT;
    this.identity = identity;
    this.label = label;
    this.udp = null;
    this.tcp = null;
    this.peers = new Map(); // fp8 -> {name, port, lastSeen, pub, dh, fp}
    this.sessions = new Set();
  }

  async listen() {
    if (this.udp) return;
    this.udp = createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise((res, rej) => { this.udp.once('error', rej); this.udp.bind(this.port, res); });
    this.udp.on('message', (msg, rinfo) => {
      try {
        const j = JSON.parse(msg.toString());
        if (j.v === 1 && j.fp && j.fp !== this.fingerprint()) {
          const key = j.fp.slice(0, 12) + ':' + rinfo.address;
          this.peers.set(key, { ...j, address: rinfo.address, lastSeen: Date.now() });
        }
      } catch {}
    });
    this.udp.setBroadcast(true);
    this.announce = setInterval(() => {
      try { this.udp.send(JSON.stringify({ v: 1, fp: this.fingerprint(), name: this.label, port: this.port, pub: this.identity.pub, dh: this.identity.dhPub }), LAN_PORT, '255.255.255.255'); } catch {}
    }, 2000);
    this.announce.unref?.();

    this.tcp = createServer((sock) => this._accept(sock));
    await new Promise((res, rej) => { this.tcp.once('error', rej); this.tcp.listen(this.port, '0.0.0.0', res); });
  }

  fingerprint() { return createHash('sha256').update(Buffer.from(this.identity.pub, 'base64')).digest('hex'); }

  seenPeers() {
    const now = Date.now();
    return [...this.peers.values()].filter((p) => now - p.lastSeen < 8000);
  }

  _accept(sock) {
    this._handshake(sock, false).catch(() => { try { sock.destroy(); } catch {} });
  }

  async _handshake(sock, initiator, expectedFp = '') {
    const myEph = ephKeys();
    const hello = { v: 1, fp: this.fingerprint(), name: this.label, pub: this.identity.pub, dh: this.identity.dhPub, eph: dhPubB64(myEph), sig: signBytes(this.identity.priv, Buffer.from(dhPubB64(myEph))) };
    const handlers = [];
    let peerHello = null;
    let resolveHello;
    const helloP = new Promise((res, rej) => { resolveHello = res; setTimeout(() => rej(new Error('handshake timeout')), 10000).unref?.(); });
    const demux = deframer((m) => {
      if (!peerHello) { peerHello = m; resolveHello(m); return; }
      try {
        const buf = Buffer.from(m.enc, 'base64');
        const d = createDecipheriv('aes-256-gcm', recvKeyRef.key, buf.subarray(0, 12));
        d.setAuthTag(buf.subarray(buf.length - 16));
        const plain = JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'));
        handlers.forEach((h) => h(plain));
      } catch {}
    });
    const recvKeyRef = { key: null };
    sock.on('data', demux);
    sock.on('error', () => {});
    sock.write(frame(hello));
    await helloP;
    if (peerHello.v !== 1 || !peerHello.pub) throw new Error('bad hello');
    if (!verifyBytes(peerHello.pub, Buffer.from(peerHello.eph || ''), peerHello.sig || '')) throw new Error('signature invalid (possible MITM)');
    if (expectedFp && peerHello.fp !== expectedFp) throw new Error('peer fingerprint mismatch');
    const secret = diffieHellman({ privateKey: myEph.privateKey, publicKey: createPublicKey({ key: Buffer.from(peerHello.eph, 'base64'), format: 'der', type: 'spki' }) });
    const transcript = [hello.eph, peerHello.eph].sort().join('|');
    const baseKey = createHash('sha256').update(secret).update(transcript).digest();
    const sendKey = createHash('sha256').update(baseKey).update(initiator ? 'a>b' : 'b>a').digest();
    recvKeyRef.key = createHash('sha256').update(baseKey).update(initiator ? 'b>a' : 'a>b').digest();
    const fpPair = [this.fingerprint(), peerHello.fp].sort().map((f) => Buffer.from(f, 'hex').subarray(0, 8));
    const words = sessionWords(Buffer.concat([baseKey, ...fpPair]));

    const send = (obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', sendKey, iv);
      const enc = Buffer.concat([iv, c.update(b), c.final(), c.getAuthTag()]);
      sock.write(frame({ enc: enc.toString('base64') }));
    };
    const api = {
      peer: { fp: peerHello.fp, name: peerHello.name, pub: peerHello.pub },
      words,
      onMessage: (fn) => handlers.push(fn),
      send,
      close: () => sock.destroy(),
    };
    this.sessions.add(api);
    api.onMessage((m) => { if (m.t === 'bye') try { sock.destroy(); } catch {} });
    this.emit('session', api);
    return api;
  }

  async connect(address, port, expectedFp = '') {
    const sock = createConnection({ host: address, port: port || this.port });
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    try {
      return await this._handshake(sock, true, expectedFp);
    } catch (e) {
      try { sock.destroy(); } catch {}
      throw e;
    }
  }

  stop() {
    clearInterval(this.announce);
    for (const s of this.sessions) { try { s.close(); } catch {} }
    try { this.udp?.close(); } catch {}
    try { this.tcp?.close(); } catch {}
    this.udp = null; this.tcp = null;
  }
}
