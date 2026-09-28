// Capsule Memory — local, encrypted, cited recall.
//
// A memory is a small text chunk with a source citation and (when an embedder
// is installed) a semantic vector. The whole index lives in ONE encrypted file
// next to the chats (same AES-256-GCM pattern as lib/chat-store.mjs):
//
//   <dataDir>/memory-store.json.enc   — the index (plaintext never touches disk)
//   <dataDir>/memory.key              — random 32B key, mode 600
//
// Search is brute-force cosine over a few thousand chunks — microseconds at
// personal scale, zero native deps, and perfectly deterministic. Keyword
// prefix matching stays as the permanent fallback when no embedder exists.
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const MAX_INDEX_BYTES = 48 * 1024 * 1024; // sanity cap; personal scale is ~MBs
const MAX_CHUNKS = 20000;
const CHUNK_CHARS = 1400;

// ── tiny text utils (kept dependency-free; mirrors the procedures matcher) ──
const STOP = new Set(['what', 'when', 'where', 'which', 'this', 'that', 'with', 'from', 'have', 'then', 'than', 'please', 'make', 'your', 'into', 'them', 'they', 'want', 'need', 'some', 'also']);
export const memoryTokens = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));

function cosine(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export const encodeVec = (arr) => Buffer.from(new Float32Array(arr).buffer).toString('base64');
export const decodeVec = (b64) => {
  const buf = Buffer.from(b64, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
};
export const textHash = (text) => createHash('sha256').update(text).digest('hex');

// Split a source document into citation-sized chunks (one per message-ish part).
export function chunkText(text, src) {
  const clean = String(text || '').replace(/\s{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const parts = [];
  let pos = 0;
  while (pos < clean.length) {
    let end = Math.min(pos + CHUNK_CHARS, clean.length);
    if (end < clean.length) {
      const piece = clean.slice(pos, end);
      const br = Math.max(piece.lastIndexOf('\n'), piece.lastIndexOf('. '));
      if (br > CHUNK_CHARS * 0.5) end = pos + br + 1;
    }
    const piece = clean.slice(pos, end).trim();
    if (piece.length >= 40) parts.push(piece);
    pos = end;
  }
  return parts.map((text, i) => ({ id: `${src.type}:${src.id}:${i}`, text: text.slice(0, CHUNK_CHARS), type: src.type, srcId: src.id, title: src.title || src.id || 'memory', index: i }));
}

function writeAtomicEnc(file, key, payload) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const blob = Buffer.concat([iv, cipher.getAuthTag(), enc]);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
  writeFileSync(tmp, blob);
  if (process.platform !== 'win32') { try { chmodSync(tmp, 0o600); } catch {} }
  renameSync(tmp, file);
}

function readEnc(file, key) {
  const buf = readFileSync(file);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + 16)), decipher.final()]).toString('utf8');
}

export class MemoryStore {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = join(dataDir, 'memory-store.json.enc');
    this.keyFile = join(dataDir, 'memory.key');
    this.chunks = new Map(); // id -> chunk (vec decoded lazily via vecB64)
    this.loaded = false;
  }

  _loadKey(create = true) {
    if (existsSync(this.keyFile)) return readFileSync(this.keyFile);
    if (!create) return null;
    const key = randomBytes(KEY_BYTES);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.keyFile, key);
    try { chmodSync(this.keyFile, 0o600); } catch {}
    return key;
  }

  load() {
    this.chunks.clear();
    this.loaded = true;
    if (!existsSync(this.file)) return 0;
    const key = this._loadKey(false);
    if (!key) return 0;
    try {
      const raw = readEnc(this.file, key);
      if (raw.length > MAX_INDEX_BYTES) throw new Error('memory index too large');
      const parsed = JSON.parse(raw);
      for (const c of parsed.chunks || []) this.chunks.set(c.id, c);
    } catch {
      this.chunks.clear(); // corrupt or wrong-key file → behave as empty
    }
    return this.chunks.size;
  }

  save() {
    const key = this._loadKey(true);
    const payload = JSON.stringify({ schema: 1, chunks: [...this.chunks.values()] }, null, 0);
    if (payload.length > MAX_INDEX_BYTES) throw new Error('memory index exceeds size cap — purge and reindex');
    writeAtomicEnc(this.file, key, payload);
  }

  purge() {
    this.chunks.clear();
    this.loaded = true;
    try { unlinkSync(this.file); } catch {}
    try { unlinkSync(this.keyFile); } catch {} // crypto-shred: the key is gone
  }

  stats() {
    const byType = {};
    for (const c of this.chunks.values()) byType[c.type] = (byType[c.type] || 0) + 1;
    return { chunks: this.chunks.size, byType };
  }

  // Re-sync one source's chunks. Changed entries (by content hash) get re-embedded.
  async syncSource(src, texts, embedder) {
    const wanted = chunkText(texts, src);
    const existing = [...this.chunks.values()].filter((c) => c.type === src.type && c.srcId === src.id);
    const keep = new Set(wanted.map((c) => c.id));
    for (const c of existing) if (!keep.has(c.id)) this.chunks.delete(c.id);
    const toEmbed = [];
    for (const c of wanted) {
      const hash = textHash(c.text);
      const prev = this.chunks.get(c.id);
      if (prev && prev.hash === hash) continue;
      const next = { ...c, hash, updated: new Date().toISOString(), vecB64: prev?.vecB64 || '' };
      this.chunks.set(c.id, next);
      if (embedder) toEmbed.push(next);
    }
    if (embedder && toEmbed.length) {
      try {
        const vecs = await embedder.embed(toEmbed.map((c) => c.text));
        toEmbed.forEach((c, i) => { if (vecs[i] && vecs[i].length) { c.vecB64 = encodeVec(vecs[i]); c.mode = 'semantic'; } });
      } catch { /* embedder down → chunks stay keyword-mode */ }
    }
    while (this.chunks.size > MAX_CHUNKS) {
      const oldest = [...this.chunks.values()].sort((a, b) => (a.updated || '').localeCompare(b.updated || ''))[0];
      if (!oldest) break;
      this.chunks.delete(oldest.id);
    }
    return { added: toEmbed.length, total: this.chunks.size };
  }

  deleteSource(type, id) {
    for (const [cid, c] of this.chunks) if (c.type === type && c.id === id) this.chunks.delete(cid);
  }

  // text: query string; vec: semantic vector if embedder live; k: results cap.
  search(text, vec, k = 6) {
    const scored = [];
    if (vec && vec.length) {
      for (const c of this.chunks.values()) {
        if (!c.vecB64) continue;
        const score = cosine(vec, decodeVec(c.vecB64));
        if (score > 0.28) scored.push({ chunk: c, score });
      }
      scored.sort((a, b) => b.score - a.score);
      if (scored.length) return scored.slice(0, k);
    }
    // keyword fallback with prefix stemming
    const q = memoryTokens(text);
    if (!q.length) return [];
    const match = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.slice(0, Math.min(a.length, b.length, 5)) === b.slice(0, Math.min(a.length, b.length, 5))));
    for (const c of this.chunks.values()) {
      const toks = memoryTokens(c.title + ' ' + c.text);
      let hits = 0;
      for (const t of q) if (toks.some((h) => match(t, h))) hits += 1;
      if (hits >= 2) scored.push({ chunk: c, score: hits / Math.max(q.length, 4) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}

// Ollama embeddings — /api/embed (new) with /api/embeddings (legacy) fallback.
export function makeOllamaEmbedder(ollamaUrl, model = process.env.LOCAL_AI_MEMORY_EMBED_MODEL || 'nomic-embed-text:latest') {
  const base = String(ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
  let cache = null;
  return {
    model,
    async available() {
      if (cache) return cache;
      try {
        const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
        const j = await r.json();
        cache = (j.models || []).some((m) => String(m.name || m.model || '') === model);
      } catch { cache = false; }
      return cache;
    },
    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts];
      const r = await fetch(`${base}/api/embed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input }), signal: AbortSignal.timeout(20000),
      });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.embeddings) && j.embeddings.length) return j.embeddings;
      }
      // legacy single-embedding endpoint
      const out = [];
      for (const t of input) {
        const r2 = await fetch(`${base}/api/embeddings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: t }), signal: AbortSignal.timeout(20000),
        });
        if (!r2.ok) throw new Error('embed failed');
        const j2 = await r2.json();
        if (!Array.isArray(j2.embedding)) throw new Error('bad embedding response');
        out.push(j2.embedding);
      }
      return out;
    },
  };
}

// Deterministic embedder for tests/probes: letter-histogram vectors; content-
// overlap between texts produces stable cosine order, no model needed.
export function makeStubEmbedder() {
  const vec = (text) => {
    const v = new Array(36).fill(0);
    for (const ch of String(text || '').toLowerCase()) {
      const i = ch >= 'a' && ch <= 'z' ? ch.charCodeAt(0) - 97 : (ch >= '0' && ch <= '9' ? 26 + ch.charCodeAt(0) - 48 : -1);
      if (i >= 0) v[i] += 1;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  };
  return { model: 'stub', available: async () => true, embed: async (texts) => (Array.isArray(texts) ? texts.map(vec) : [vec(texts)]) };
}
