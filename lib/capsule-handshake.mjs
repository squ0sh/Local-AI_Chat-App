// Capsule handshake: the transport-agnostic postcard protocol.
//
// Every exchangeable thing — a contact card, a memory fact, a procedure, a
// note — travels in a CAPX1 envelope: named, signed, optionally sealed, and
// fragmentable into base45 text that fits LoRa bursts, ham packet frames,
// QR codes, pasted chat, or a USB stick. No networking assumptions live here:
// a socket, a file, and a radio burst all carry the same text.
//
// Modes:
//   open   — plaintext + signature (required on ham bands; content visible)
//   sealed — X25519 ECDH + AES-256-GCM body encryption, sealed to one peer
//            (mutual consent: only the addressed key reads it)
import { generateKeyPairSync, sign, verify, diffieHellman, createHash, randomBytes, createCipheriv, createDecipheriv, createPublicKey, createPrivateKey } from 'crypto';

// ── Frame body encoding: base64url ──────────────────────────────────────────
// base64url travels cleanly through QR encoders, chat apps, packet text, and
// retyped notes — and it contains NO whitespace characters, so decoders may
// freely strip layout whitespace that terminals and wrap-prone media insert.
const encB64u = (buf) => Buffer.from(buf).toString('base64url');
const decB64u = (str) => Buffer.from(str, 'base64url');

// ── Keys ─────────────────────────────────────────────────────────────────────
export function newDeviceIdentity() {
  const kp = generateKeyPairSync('ed25519');
  const dh = generateKeyPairSync('x25519');
  return {
    pub: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    priv: kp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    dhPub: dh.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    dhPriv: dh.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function fingerprint(pubB64) {
  return createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex');
}
export const fpShort = (fp) => String(fp || '').slice(0, 12);

// Tiny wordlist for six-word safety phrases (fixed, public; entropy comes from
// the fingerprint itself — the words are the human channel, not the crypto).
const WORDS = ('amber atlas beacon birch bloom cedar cedar cliff comet coral delta ember fern flint frost garnet globe harbor hazel hollow indigo ivory jade juniper kelp lagoon lark linen lotus lumen maple harbor meadow mesa mistral mosaic nimbus north olive onyx orchid otter pebble pine plume quartz raven reef river saffron sage sandal shadow silver solar sonnet sparrow spring summit talc thistle timber tundra umber velvet violet walnut willow winter zephyr'.split(' '));
export function wordsPhrase(pubB64) {
  const h = createHash('sha256').update('words:' + pubB64).digest();
  const words = [];
  for (let i = 0; i < 6; i += 1) words.push(WORDS[h[i] % WORDS.length]);
  return words.join(' ');
}

const signBuf = (privB64, bytes) => sign(null, Buffer.from(bytes), createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64');
const verifyBuf = (pubB64, bytes, sigB64) => verify(null, Buffer.from(bytes), createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' }), Buffer.from(sigB64, 'base64'));

// ── Contact cards (tier 0) ──────────────────────────────────────────────────
export function makeCard(identity, { name, caps = ['memory', 'procedure', 'note'] }) {
  const at = new Date().toISOString();
  const body = { v: 1, kind: 'capx-card', name: String(name || '').slice(0, 60), pub: identity.pub, dh: identity.dhPub, caps, at };
  body.sig = signBuf(identity.priv, canonicalCardBytes(body));
  return body;
}
function canonicalCardBytes(card) {
  return Buffer.from(JSON.stringify({ v: card.v, kind: card.kind, name: card.name, pub: card.pub, dh: card.dh, caps: card.caps, at: card.at }));
}
export function readCard(card) {
  if (!card || card.kind !== 'capx-card' || !card.pub || !card.sig || !card.dh) throw new Error('not a capsule card');
  if (!verifyBuf(card.pub, canonicalCardBytes(card), card.sig)) throw new Error('card signature invalid');
  return { name: card.name, pub: card.pub, dhPub: card.dh, fp: fingerprint(card.pub), words: wordsPhrase(card.pub), caps: card.caps || [], at: card.at };
}

// ── Postcards (tier 1) ──────────────────────────────────────────────────────
// Body payload (JSON) sits inside; envelope fields are readable so relays,
// radios, and curious humans can route without ever opening it.
export function packPostcard(identity, { kind, to = '*', item, mode = 'sealed', toDhPub = '' }) {
  if (!['memory', 'procedure', 'note', 'cardref', 'ack'].includes(kind)) throw new Error('bad postcard kind');
  if (mode === 'sealed' && !toDhPub) throw new Error('sealed mode needs the recipient DH key');
  const inner = JSON.stringify({ kind, item, at: new Date().toISOString() });
  let bodyB64, eph = '';
  if (mode === 'sealed') {
    const k = generateKeyPairSync('x25519');
    eph = k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const shared = diffieHellman({ privateKey: k.privateKey, publicKey: createPublicKey({ key: Buffer.from(toDhPub, 'base64'), format: 'der', type: 'spki' }) });
    const key = createHash('sha256').update(shared).update('capx-seal').digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(inner, 'utf8'), cipher.final()]);
    bodyB64 = Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  } else {
    bodyB64 = Buffer.from(inner, 'utf8').toString('base64');
  }
  const env = {
    v: 1, src: fingerprint(identity.pub), kind, mode, to: to === '*' ? '*' : String(to),
    frag: '1/1', eph, body: bodyB64,
  };
  env.sig = signBuf(identity.priv, canonicalEnvBytes(env));
  return env;
}
function canonicalEnvBytes(env) {
  return Buffer.from(JSON.stringify({ v: env.v, src: env.src, kind: env.kind, mode: env.mode, to: env.to, frag: env.frag, eph: env.eph || '', body: env.body }));
}

export function unpackPostcard(env, { identity, trustedPubs = [] } = {}) {
  // Contact-card frames are the trust root: the inner card is self-signed and
  // must bind to the envelope fingerprint — no prior peer trust required.
  if (env.kind === 'cardref' && env.mode === 'open') {
    const inner = JSON.parse(Buffer.from(env.body, 'base64').toString('utf8'));
    const card = readCard(inner.item);
    if (card.fp !== env.src) throw new Error('the card does not belong to the envelope sender');
    return { ...inner, src: env.src, sealed: false, card };
  }
  const known = [...(trustedPubs || [])];
  if (identity?.pub && fingerprint(identity.pub) === env.src) known.push(identity.pub); // self is trusted
  const headerOk = verifyBufWithFp(fpToPub(env.src, known), canonicalEnvBytes(env), env.sig);
  if (!headerOk) throw new Error('postcard signature invalid');
  if (env.mode === 'sealed') {
    if (!identity || !identity.dhPriv) throw new Error('sealed postcard: this device has no key here');
    const ephPub = createPublicKey({ key: Buffer.from(env.eph, 'base64'), format: 'der', type: 'spki' });
    const shared = diffieHellman({
      privateKey: createPrivateKey({ key: Buffer.from(identity.dhPriv, 'base64'), format: 'der', type: 'pkcs8' }),
      publicKey: ephPub,
    });
    const key = createHash('sha256').update(shared).update('capx-seal').digest();
    const buf = Buffer.from(env.body, 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const inner = JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8'));
    return { ...inner, src: env.src, sealed: true };
  }
  const inner = JSON.parse(Buffer.from(env.body, 'base64').toString('utf8'));
  return { ...inner, src: env.src, sealed: false };
}
function verifyBufWithFp(pubB64, bytes, sigB64) {
  try { return verifyBuf(pubB64, bytes, sigB64); } catch { return false; }
}
function fpToPub(fp, trustedPubs) {
  const hit = (trustedPubs || []).find((p) => fingerprint(p.pub || p) === fp);
  if (!hit) throw new Error('unknown sender fingerprint');
  return hit.pub || hit;
}

// ── Text frames: the same envelope, as copy-pasteable line blocks ───────────
// Framing is LENGTH-PREFIXED: base45 is an uppercase alphabet that may legally
// contain any marker string (even "CAPX1/"), so frames never trust delimiters.
// Whitespace is cosmetic everywhere — decoders ignore it (radios mangle it).
export function envToText(env, chunkSize = 180) {
  const enc = encB64u(Buffer.from(JSON.stringify(env), 'utf8'));
  const fragCount = Math.max(1, Math.ceil(enc.length / chunkSize));
  const frames = [];
  for (let i = 0; i < fragCount; i += 1) {
    const part = enc.slice(i * chunkSize, (i + 1) * chunkSize);
    frames.push(`CAPX1 ${env.kind} ${fpShort(env.src)} frag${i + 1}of${fragCount} sig${(env.sig || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10)} len${part.length}\n${part}`);
  }
  return frames.join('\n');
}
export function textToEnv(text) {
  const s = String(text || '');
  const parts = [];
  const re = /CAPX1 [a-z]+ [0-9a-f]{12} frag(\d+)of(\d+) sig[A-Za-z0-9]{0,10} len(\d+)\s*/g;
  let m;
  while ((m = re.exec(s))) {
    const want = Number(m[3]);
    let i = m.index + m[0].length;
    const got = [];
    // base64url carries no whitespace, so layout whitespace is always skipable.
    while (i < s.length && got.length < want) {
      const ch = s[i];
      if (!/\s/.test(ch)) got.push(ch);
      i += 1;
    }
    if (got.length !== want) throw new Error(`fragment ${m[1]}/${m[2]} truncated`);
    parts.push({ i: Number(m[1]), n: Number(m[2]), body: got.join('') });
  }
  if (!parts.length) throw new Error('no CAPX1 frames found');
  const n = parts[0].n;
  if (parts.some((p) => p.n !== n)) throw new Error('mixed frame sets');
  const byIndex = new Map(parts.map((p) => [p.i, p]));
  const ordered = [];
  for (let i = 1; i <= n; i += 1) {
    const p = byIndex.get(i);
    if (!p) throw new Error(`missing fragment ${i}/${n}`);
    ordered.push(p.body);
  }
  return JSON.parse(decB64u(ordered.join('')).toString('utf8'));
}
