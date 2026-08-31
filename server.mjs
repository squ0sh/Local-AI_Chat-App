/**
 * local-chat server.mjs
 * Local AI chat app + OpenAI-compatible API server for Ollama models.
 *
 * Two modes:
 *   local  — serve chat UI + OpenAI-compatible proxy on http://localhost:PORT
 *   tunnel — additionally expose the same server through a Cloudflare quick tunnel
 *
 * The proxy is a thin passthrough to Ollama's built-in OpenAI-compatible
 * endpoints (/v1/models, /v1/chat/completions), so any OpenAI client and the
 * bundled chat UI work directly against local models.
 */

import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, createWriteStream, copyFileSync, chmodSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ static paths
const HTML_FILE = join(__dirname, 'index.html');
const INDEX_HTML = existsSync(HTML_FILE) ? readFileSync(HTML_FILE, 'utf8') : null;

// Root data dir lives three levels up: chat-app -> OpenClaude-Portable/data
const ROOT_DIR = join(__dirname, '..');
const DATA_DIR = join(ROOT_DIR, 'data');
const ENV_FILE = join(DATA_DIR, 'ai_settings.env');

// Local model drop folder — place .gguf (and Ollama Modelfile) files here to
// run models fully offline without any API. The server auto-detects these and
// registers them with the (bundled) local Ollama instance.
const MODELS_DIR = join(__dirname, 'models');
try { mkdirSync(MODELS_DIR, { recursive: true }); } catch {}

// In-memory track of background model downloads: id -> { spec, status, filename, downloaded, total, error }
const downloads = new Map();
let downloadSeq = 0;

// ------------------------------------------------------------------ provider config
function readConfig() {
  if (!existsSync(ENV_FILE)) return {};
  const raw = readFileSync(ENV_FILE, 'utf-8');
  const config = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    config[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return config;
}

// ------------------------------------------------------------------ local models folder
// Locate the bundled Ollama binary (used to serve .gguf models from models/).
function ollamaBin() {
  const candidates = [];
  if (existsSync(DATA_DIR)) {
    const plat = process.platform;
    candidates.push(join(DATA_DIR, 'ollama', 'ollama'));
    candidates.push(join(DATA_DIR, 'ollama', `ollama-${plat}`));
    if (plat === 'win32') candidates.push(join(DATA_DIR, 'ollama', 'ollama.exe'));
  }
  candidates.push('ollama'); // fall back to PATH
  for (const c of candidates) {
    if (c === 'ollama') return c;
    try { if (existsSync(c)) return c; } catch {}
  }
  return 'ollama';
}

// Matches a GGUF shard name of the form `<base>-NNNNN-of-MMMMM.gguf`.
const SHARD_RE = /^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i;

// Group GGUF files into logical models. Single-file models (no shard suffix)
// map to one entry; multi-shard models (e.g. foo-00001-of-00002.gguf +
// foo-00002-of-00002.gguf) are grouped under their shared base name with the
// shards listed in order.
function groupGgufModels(entries) {
  const files = [];
  for (const name of entries.sort()) {
    if (!/\.gguf$/i.test(name)) continue;
    let st;
    try { st = statSync(join(MODELS_DIR, name)); } catch { continue; }
    if (!st.isFile()) continue;
    files.push({ file: name, size: st.size });
  }

  const single = new Map();
  const sharded = new Map(); // base -> array of { file, size, idx, total }
  for (const f of files) {
    const m = f.file.match(SHARD_RE);
    if (m) {
      const base = m[1];
      const idx = parseInt(m[2], 10);
      const total = parseInt(m[3], 10);
      if (!sharded.has(base)) sharded.set(base, []);
      sharded.get(base).push({ ...f, idx, total });
    } else {
      single.set(f.file.replace(/\.gguf$/i, ''), f);
    }
  }

  const out = [];
  for (const [name, f] of single) {
    out.push({ name, files: [f.file], size: f.size, kind: 'gguf' });
  }
  for (const [base, shards] of sharded) {
    shards.sort((a, b) => a.idx - b.idx);
    const totalSize = shards.reduce((s, x) => s + x.size, 0);
    out.push({
      name: base,
      files: shards.map((s) => s.file),
      size: totalSize,
      kind: 'gguf',
      shards,
    });
  }
  return out;
}

// List local model files (gguf, safetensors) + Ollama Modelfile entries in models/.
function scanModels() {
  let entries = [];
  try { entries = readdirSync(MODELS_DIR); } catch { return []; }

  const out = groupGgufModels(entries);

  // Also surface Modelfile files as informational entries.
  for (const name of entries.sort()) {
    if (!/\.safetensors$/i.test(name)) continue;
    let st;
    try { st = statSync(join(MODELS_DIR, name)); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ name: name.replace(/\.safetensors$/i, ''), files: [name], size: st.size, kind: 'safetensors' });
  }

  return out;
}

// Resolve the absolute paths of a model's GGUF shard(s).
function resolveModelFiles(m) {
  if (m.files && m.files.length) return m.files.map((f) => join(MODELS_DIR, f));
  return [join(MODELS_DIR, m.name + '.gguf')];
}

// Register a local .gguf model into the bundled Ollama instance via
// `ollama create <name> -f <Modelfile>`. Supports multi-shard GGUF models by
// emitting multiple `FROM` lines. Returns {ok, name} or throws.
function registerLocalModel(name, files) {
  return new Promise((resolve, reject) => {
    const bin = ollamaBin();
    const paths = files || [join(MODELS_DIR, name + '.gguf')];
    for (const p of paths) {
      if (!existsSync(p)) return reject(new Error(`No .gguf found for "${name}" in ${MODELS_DIR}`));
    }
    const fromLines = paths.map((p) => `FROM ${p.replace(/\\/g, '/')}`).join('\n');
    const modelfile = fromLines + '\n';
    try {
      const proc = spawn(bin, ['create', name, '-f', '-'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stdout.on('data', () => {});
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.stdin.write(modelfile);
      proc.stdin.end();
      proc.on('error', (e) => reject(new Error(e.message)));
      proc.on('close', (code) => {
        if (code === 0) resolve({ ok: true, name });
        else reject(new Error(stderr.trim() || `ollama create exited with code ${code}`));
      });
    } catch (e) {
      reject(e);
    }
  });
}

// Register all .gguf models in models/ that are not yet in Ollama's registry.
async function autoRegisterLocalModels() {
  const local = scanModels().filter((m) => m.kind === 'gguf');
  if (!local.length) return;
  // Query Ollama registry to see what's already registered.
  let existing = new Set();
  try {
    const r = await upstreamRequest('GET', '/api/tags', { timeout: 4000 });
    if (r.ok) {
      const j = JSON.parse(await r.text());
      for (const t of (j.models || [])) existing.add(t.name.split(':')[0]);
    }
  } catch {}
  for (const m of local) {
    if (existing.has(m.name)) continue;
    try {
      await registerLocalModel(m.name, resolveModelFiles(m));
      console.log(`  [models] registered ${m.name} from ${m.files.join(', ')}`);
    } catch (e) {
      console.log(`  [models] could not register ${m.name}: ${e.message}`);
    }
  }
}

// ------------------------------------------------------------------ CLI/config
function parseArgs(argv) {
  const cfg = {
    mode: 'local',
    // Bind locally by default. Public/LAN exposure should always be explicit.
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 5173),
    ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    authToken: process.env.AUTH_TOKEN || '',
    cloudflaredPath: process.env.CLOUDFLARED_PATH || '',
  };
  // Merge saved provider config (data/ai_settings.env) for cross-provider support.
  const env = readConfig();
  cfg.aiProvider = env.AI_PROVIDER || '';
  cfg.model = env.OPENAI_MODEL || env.AI_DISPLAY_MODEL || '';
  cfg.openaiBaseUrl = env.OPENAI_BASE_URL || '';
  cfg.openaiApiKey = env.OPENAI_API_KEY || '';
  cfg.anthropicApiKey = env.ANTHROPIC_API_KEY || '';
  cfg.geminiApiKey = env.GEMINI_API_KEY || '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--mode' || a === '-m') cfg.mode = next() || 'local';
    else if (a === '--port' || a === '-p') cfg.port = Number(next() || 5173);
    else if (a === '--host') cfg.host = next() || null;
    else if (a === '--ollama-url' || a === '-u') cfg.ollamaUrl = (next() || cfg.ollamaUrl).replace(/\/+$/, '');
    else if (a === '--auth-token') cfg.authToken = next() || '';
    else if (a === '--cloudflared') cfg.cloudflaredPath = next() || '';
    else if (a === 'local' || a === 'tunnel') cfg.mode = a;
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  if (!/^https?:\/\//.test(cfg.ollamaUrl)) cfg.ollamaUrl = 'http://' + cfg.ollamaUrl;
  return cfg;
}

const cfg = parseArgs(process.argv.slice(2));

// ------------------------------------------------------------------ utilities
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const RESP_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', ...CORS };

const isWin = () => process.platform === 'win32';

function log(...args) { console.log(new Date().toISOString(), ...args); }

function sendJSON(res, code, obj) {
  res.writeHead(code, RESP_HEADERS);
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Request body exceeds the 1 MB limit'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function upstreamRequest(method, path, { body, headers = {}, timeout = 120000 } = {}) {
  const url = cfg.ollamaUrl + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const h = { 'Content-Type': 'application/json', ...headers };
  if (body != null) h['Content-Length'] = String(Buffer.byteLength(body));
  return fetch(url, { method, headers: h, body, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function findOnPath(name) {
  const paths = (process.env.PATH || '').split(isWin() ? ';' : ':').filter(Boolean);
  const exts = isWin() ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of paths) {
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

// ------------------------------------------------------------------ handlers
function authorize(req, url) {
  if (!cfg.authToken) return '';
  const header = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const query = url.searchParams.get('auth_token') || '';
  return header || query;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // Browsers cannot attach a bearer token to CORS preflight requests.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // Keep the shell reachable so a user can enter AUTH_TOKEN in the UI.
  // All dynamic routes below remain protected.
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    if (INDEX_HTML === null) return sendJSON(res, 500, { error: 'index.html not found' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(INDEX_HTML);
  }

  const provided = authorize(req, url);
  if (cfg.authToken && provided !== cfg.authToken) {
    return sendJSON(res, 401, { error: 'Unauthorized: missing or invalid AUTH_TOKEN' });
  }

  // ── Health probe (drives the UI connection pill) ─────────────────────────
  if (req.method === 'GET' && p === '/health') {
    let ollama = false, version = '';
    if (!isCloudProvider()) {
      try {
        const u = await fetch(cfg.ollamaUrl + '/api/version', { signal: AbortSignal.timeout(4000) });
        if (u.ok) { ollama = true; const j = await u.json().catch(() => ({})); version = j.version || ''; }
      } catch {}
    }
    return sendJSON(res, 200, {
      ok: true,
      ollama,
      ollama_url: cfg.ollamaUrl,
      version,
      mode: cfg.mode,
      provider: cfg.aiProvider || 'ollama',
      model: cfg.model || '',
    });
  }

  // ── Native model list ────────────────────────────────────────────────────
  if (req.method === 'GET' && (p === '/api/models' || p === '/models')) {
    if (cfg.aiProvider === 'openai' || cfg.aiProvider === 'anthropic' || cfg.aiProvider === 'gemini') {
      return sendJSON(res, 200, { models: cfg.model ? [{ name: cfg.model }] : [] });
    }
    return listModels(res);
  }

  // ── Local model folder listing ───────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/models/local') {
    return sendJSON(res, 200, { models: scanModels(), folder: MODELS_DIR });
  }

  // ── Register a local .gguf model into Ollama (creates an importable model) ─
  if (req.method === 'POST' && p === '/api/models/register') {
    let b;
    try { b = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    let payload = {};
    try { payload = JSON.parse(b || '{}'); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    const name = (payload.name || '').trim();
    if (!name) return sendJSON(res, 400, { error: 'Missing model name' });
    try {
      const model = scanModels().find((m) => m.name === name);
      const result = await registerLocalModel(name, model ? resolveModelFiles(model) : undefined);
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 500, { error: 'Registration failed: ' + e.message });
    }
  }

  // ── Download a model (.gguf) from HuggingFace or a direct URL ────────────
  if (req.method === 'POST' && p === '/api/models/download') {
    let b;
    try { b = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    let payload = {};
    try { payload = JSON.parse(b || '{}'); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    const spec = (payload.spec || '').trim();
    if (!spec) return sendJSON(res, 400, { error: 'Missing spec (HuggingFace repo id, file path, or URL)' });

    const id = 'dl-' + (++downloadSeq);
    const job = { id, spec, status: 'starting', filename: null, downloaded: 0, total: 0, error: null };
    downloads.set(id, job);

    (async () => {
      try {
        const result = await downloadModel(spec, (p) => {
          job.downloaded = p.downloaded;
          job.total = p.total;
          job.filename = p.filename || job.filename;
          job.status = 'downloading';
        });
        job.filename = result.filenames.join(', ');
        job.base = result.base;
        job.status = 'done';
        // Auto-register with Ollama if a local/ollama provider is active.
        if (!isCloudProvider()) {
          try { job.status = 'registering'; await autoRegisterLocalModels(); }
          catch (e) { log('[download] registration error:', e.message); }
        }
        job.status = 'ready';
      } catch (e) {
        job.error = e.message;
        job.status = 'error';
      }
    })();

    return sendJSON(res, 200, { id, status: job.status });
  }

  if (req.method === 'GET' && p === '/api/models/download') {
    const id = url.searchParams.get('id') || '';
    const job = id ? downloads.get(id) : null;
    if (!job) return sendJSON(res, 404, { error: 'Unknown download id' });
    return sendJSON(res, 200, job);
  }

  if (req.method === 'GET' && p === '/api/models/downloads') {
    return sendJSON(res, 200, { downloads: [...downloads.values()] });
  }

  // ── Native streaming chat (used by the bundled UI) ───────────────────────
  if (p === '/api/chat' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    let payload;
    try { payload = JSON.parse(body || '{}'); }
    catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    return streamChat(payload, res);
  }

  // ── Provider routing for /v1/* endpoints ────────────────────────────────
  // If a non-Ollama provider is configured, translate OpenAI-compatible
  // requests to that provider's native API instead of proxying to Ollama.
  if (p === '/v1/models') {
    if (isCloudProvider()) return proxyCloud('GET', '/v1/models', null, res);
    return proxyV1('GET', '/v1/models', null, res);
  }
  if (p === '/v1/chat/completions' || p === '/v1/completions' || p === '/v1/embeddings') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    if (isCloudProvider()) return proxyCloud(req.method, p, body, res);
    return proxyV1(req.method, p, body, res);
  }
  if (p.startsWith('/v1/')) {
    let body = null;
    if (req.method !== 'GET') { try { body = await readBody(req); } catch {} }
    if (isCloudProvider()) return proxyCloud(req.method, p, body, res);
    return proxyV1(req.method, p, body, res);
  }

  sendJSON(res, 404, { error: 'Not found' });
}

function isCloudProvider() {
  return cfg.aiProvider === 'openai' || cfg.aiProvider === 'anthropic' || cfg.aiProvider === 'gemini';
}

// Merge Ollama's registry (/api/tags) with the local models/ folder. Local
// .gguf files appear as first-class local models selectable in the UI.
async function listModels(res) {
  const local = scanModels().filter((m) => m.kind === 'gguf');
  let tags = [];
  try {
    const r = await upstreamRequest('GET', '/api/tags', { timeout: 6000 });
    if (r.ok) {
      const data = await r.text();
      try { const j = JSON.parse(data); tags = j.models || []; } catch {}
    }
    res.writeHead(200, RESP_HEADERS);
    const merged = [];
    const seen = new Set();
    // Ollama-registered models first (already importable via their name).
    for (const t of tags) {
      merged.push({ name: t.name, source: 'ollama', details: t.details || {} });
      seen.add(t.name.split(':')[0]);
    }
    // Local folder models (not yet registered) appear with their filename.
    for (const m of local) {
      if (seen.has(m.name)) continue;
      merged.push({ name: m.name, source: 'local', files: m.files, size: m.size });
      seen.add(m.name);
    }
    return res.end(JSON.stringify({ models: merged }));
  } catch (e) {
    // Ollama offline — still surface the local folder models.
    const merged = local.map((m) => ({ name: m.name, source: 'local', files: m.files, size: m.size }));
    return res.end(JSON.stringify({ models: merged }));
  }
}

async function proxyV1(method, path, body, res) {
  try {
    const headers = { Accept: '*/*' };
    const upKey = process.env.OLLAMA_API_KEY;
    if (upKey) headers['Authorization'] = 'Bearer ' + upKey;

    const r = await upstreamRequest(method, path, {
      body,
      headers,
      timeout: 300000,
    });

    for (const [k, v] of ['content-type', 'cache-control', 'connection', 'transfer-encoding']) {
      const val = r.headers.get(k);
      if (val) res.setHeader(k, val);
    }
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    res.writeHead(r.status);
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (e) {
    try { sendJSON(res, 502, { error: 'Upstream proxy error: ' + e.message }); } catch {}
  }
}

// ------------------------------------------------- cross-provider support
// Mirrors dashboard/server.mjs provider dispatch so the chat-app reuses the
// provider already saved in data/ai_settings.env (no re-entering credentials).

function anthropicBase() {
  return 'https://api.anthropic.com/v1';
}

function geminiUrl(model, stream) {
  const m = model || 'gemini-2.0-pro-exp-02-05';
  const op = stream ? 'streamGenerateContent' : 'generateContent';
  return `https://generativelanguage.googleapis.com/v1beta/models/${m}:${op}?key=${cfg.geminiApiKey}`;
}

function openaiBase() {
  return (cfg.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

// Convert OpenAI chat-completions message list into Anthropic's wire format.
function toAnthropicMessages(messages) {
  let system = '';
  const filtered = [];
  for (const m of messages) {
    if (m.role === 'system') system = (system ? system + '\n' : '') + m.content;
    else filtered.push({ role: m.role, content: m.content });
  }
  return { system, filtered };
}

// Convert OpenAI chat-completions message list into Gemini's wire format.
function toGeminiContents(messages) {
  const contents = [];
  let system = '';
  for (const m of messages) {
    if (m.role === 'system') { system = (system ? system + '\n' : '') + m.content; continue; }
    const role = m.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: m.content }] });
  }
  return { contents, system };
}

// Route /v1/* OpenAI-compatible requests to the active cloud provider.
async function proxyCloud(method, path, body, res) {
  const mapped = mapProviderPath(path, method, body);
  if (!mapped) return sendJSON(res, 404, { error: 'Unsupported endpoint for provider: ' + cfg.aiProvider });
  const { url, headers } = mapped;
  try {
    const h = { ...(mapped.body != null ? { 'Content-Type': 'application/json' } : {}), ...headers };
    const r = await fetch(url, { method, headers: h, ...(mapped.body != null ? { body: mapped.body } : {}) });
    for (const [k, v] of ['content-type', 'cache-control', 'connection', 'transfer-encoding']) {
      const val = r.headers.get(k);
      if (val) res.setHeader(k, val);
    }
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    res.writeHead(r.status);
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (e) {
    try { sendJSON(res, 502, { error: 'Provider proxy error: ' + e.message }); } catch {}
  }
}

// Build the provider-specific request for a given OpenAI-compatible path.
function mapProviderPath(path, method, body) {
  let payload;
  try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }

  if (cfg.aiProvider === 'openai') {
    const url = openaiBase() + path;
    const headers = { 'Authorization': 'Bearer ' + (cfg.openaiApiKey || '') };
    if (openaiBase().includes('openrouter')) {
      headers['HTTP-Referer'] = 'http://localhost:5173';
      headers['X-Title'] = 'Local AI Chat';
    }
    return { url, headers, body };
  }

  if (cfg.aiProvider === 'anthropic') {
    if (path === '/v1/models') return null; // Anthropic has no OpenAI-style models endpoint
    const model = (payload.model || cfg.model || 'claude-3-5-sonnet-20241022');
    const { system, filtered } = toAnthropicMessages(payload.messages || []);
    const ap = {
      model,
      messages: filtered,
      max_tokens: payload.max_tokens || 4096,
      stream: Boolean(payload.stream),
    };
    if (system) ap.system = system;
    const headers = {
      'x-api-key': cfg.anthropicApiKey || '',
      'anthropic-version': '2023-06-01',
    };
    return { url: anthropicBase() + '/messages', headers, body: JSON.stringify(ap) };
  }

  if (cfg.aiProvider === 'gemini') {
    if (path === '/v1/models') {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${cfg.geminiApiKey}`,
        headers: {},
        body: null,
      };
    }
    const stream = Boolean(payload.stream);
    const model = payload.model || cfg.model || 'gemini-2.0-pro-exp-02-05';
    const { contents, system } = toGeminiContents(payload.messages || []);
    const gp = { contents };
    if (system) gp.system_instruction = { parts: [{ text: system }] };
    return { url: geminiUrl(model, stream), headers: {}, body: JSON.stringify(gp) };
  }

  return null;
}

// Native streaming chat for the bundled UI. Emits OpenAI-style SSE tokens.
async function streamChat(payload, res) {
  const provider = cfg.aiProvider || 'ollama';
  const messages = payload.messages || [];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    ...CORS,
  });
  const sendSSE = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
  const finish = (fullText) => { sendSSE({ type: 'done', fullText }); res.end(); };
  const fail = (msg) => { sendSSE({ type: 'error', content: msg }); res.end(); };

  if (provider === 'anthropic') {
    const model = payload.model || cfg.model || 'claude-3-5-sonnet-20241022';
    const { system, filtered } = toAnthropicMessages(messages);
    const body = JSON.stringify({
      model,
      messages: filtered,
      max_tokens: 4096,
      stream: true,
      ...(system ? { system } : {}),
    });
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': cfg.anthropicApiKey || '',
      'anthropic-version': '2023-06-01',
    };
    let fullText = '';
    try {
      const r = await fetch(anthropicBase() + '/messages', { method: 'POST', headers, body });
      if (!r.ok) return fail('Anthropic HTTP ' + r.status + ': ' + await r.text().then(t => t.slice(0, 300)));
      const text = await r.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const parsed = JSON.parse(raw);
          const delta = parsed.delta?.text || '';
          if (parsed.type === 'error') return fail(parsed.error?.message || 'Anthropic stream error');
          if (delta) { fullText += delta; sendSSE({ type: 'delta', content: delta }); }
        } catch {}
      }
      return finish(fullText);
    } catch (e) { return fail(e.message); }
  }

  if (provider === 'gemini') {
    const model = payload.model || cfg.model || 'gemini-2.0-pro-exp-02-05';
    const { contents, system } = toGeminiContents(messages);
    const body = JSON.stringify({ contents, ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}) });
    const headers = { 'Content-Type': 'application/json' };
    let fullText = '';
    try {
      const r = await fetch(geminiUrl(model, true), { method: 'POST', headers, body });
      if (!r.ok) return fail('Gemini HTTP ' + r.status + ': ' + await r.text().then(t => t.slice(0, 300)));
      const chunks = await r.text();
      // Gemini SSE: each data line is a JSON object; text lives in candidates[].content.parts[].text
      for (const line of chunks.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(line.slice(6).trim());
          const parts = parsed.candidates?.[0]?.content?.parts || [];
          for (const prt of parts) {
            if (prt.text) { fullText += prt.text; sendSSE({ type: 'delta', content: prt.text }); }
          }
        } catch {}
      }
      return finish(fullText);
    } catch (e) { return fail(e.message); }
  }

  // OpenAI-compatible: OpenAI / OpenRouter / Ollama / LM Studio / custom API.
  const baseUrl = provider === 'ollama'
    ? cfg.ollamaUrl
    : openaiBase();
  const apiKey = provider === 'ollama' ? (process.env.OLLAMA_API_KEY || '') : cfg.openaiApiKey;
  const model = payload.model || cfg.model || '';
  const body = JSON.stringify({ model, messages, stream: true });
  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}),
  };
  if (baseUrl.includes('openrouter')) {
    headers['HTTP-Referer'] = 'http://localhost:5173';
    headers['X-Title'] = 'Local AI Chat';
  }
  let fullText = '';
  try {
    const chatPath = provider === 'ollama' ? '/v1/chat/completions' : '/chat/completions';
    const r = await fetch(baseUrl + chatPath, { method: 'POST', headers, body });
    if (!r.ok) return fail('Upstream HTTP ' + r.status + ': ' + await r.text().then(t => t.slice(0, 300)));
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consumeLine = (line) => {
      if (!line.startsWith('data: ')) return;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') return;
      try {
        const parsed = JSON.parse(raw);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) { fullText += delta; sendSSE({ type: 'delta', content: delta }); }
      } catch {}
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    }
    if (buffer) consumeLine(buffer);
    return finish(fullText);
  } catch (e) { return fail(e.message); }
}

// ------------------------------------------------------- tunnel support
function bundledBin() {
  return join(__dirname, 'data', 'bin', isWin() ? 'cloudflared.exe' : 'cloudflared');
}

function spawnCloudflared() {
  const found = cfg.cloudflaredPath || findOnPath('cloudflared') || (existsSync(bundledBin()) ? bundledBin() : '');
  if (!found) return null;
  const args = ['tunnel', '--url', 'http://localhost:' + cfg.port, '--no-autoupdate'];
  const child = spawn(found, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => {
    const line = d.toString();
    const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) console.log('\n  🌍 Public URL: ' + m[0] + '\n');
    process.stdout.write(line);
  });
  child.stderr.on('data', (d) => process.stderr.write(d.toString()));
  child.on('error', (e) => log('cloudflared error:', e.message));
  child.on('exit', (c) => log('cloudflared exited with code', c));
  return found;
}

async function downloadCloudflared() {
  const cwd = join(__dirname, 'data', 'bin');
  mkdirSync(cwd, { recursive: true });
  let asset;
  if (isWin()) asset = 'cloudflared-windows-amd64.exe';
  else if (process.platform === 'darwin')
    asset = process.arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  else asset = process.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';

  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset;
  const dest = bundledBin();
  console.log('  ⬇  Downloading Cloudflare tunnel binary (' + asset + ') …');
  const r = await fetch(url);
  if (!r.ok) throw new Error('Download failed: HTTP ' + r.status);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
  if (process.platform === 'darwin') {
    const tmp = dest + '.dir';
    mkdirSync(tmp, { recursive: true });
    execSync('tar -xzf "' + dest + '" -C "' + tmp + '"');
    copyFileSync(join(tmp, 'cloudflared'), dest);
  }
  if (!isWin()) chmodSync(dest, 0o755);
  console.log('  ✅  Saved to ' + dest);
  return dest;
}

// Resolve a model download spec into a list of files to fetch. Accepts:
//   - a direct URL (filename taken from the URL path, must end in .gguf)
//   - a HuggingFace repo id `owner/repo` (streams main-branch file tree)
//   - a HuggingFace file path `owner/repo/file.gguf`
// For a `owner/repo` spec, we prefer a single non-sharded .gguf; if the repo
// only contains shards, we download ALL shards of one base quantization.
// Returns { files: [{ url, filename }], base } where `base` is the model name
// (shard suffix stripped) and `files` is in shard order.
async function resolveModelDownload(spec) {
  spec = (spec || '').trim();
  if (/^https?:\/\//i.test(spec)) {
    const name = decodeURIComponent(spec.split('?')[0].split('/').pop() || '');
    if (!name || !/\.gguf$/i.test(name)) throw new Error('Direct URLs must point at a .gguf file');
    return { files: [{ url: spec, filename: name }], base: name.replace(/\.gguf$/i, '') };
  }
  const parts = spec.split('/');
  if (parts.length < 2) throw new Error('Expected a URL or "owner/repo" HuggingFace id');
  const repo = parts[0] + '/' + parts[1];

  const toItem = (path) => ({
    filename: decodeURIComponent(path.split('/').pop()),
    url: 'https://huggingface.co/' + repo + '/resolve/main/' + encodeURIComponent(path),
    path,
  });

  // Explicit file path e.g. `owner/repo/sub/file.gguf`
  if (parts.length > 2) {
    const rel = parts.slice(2).join('/');
    if (!/\.gguf$/i.test(rel)) throw new Error('HuggingFace file must be a .gguf file');
    const item = toItem(rel);
    return { files: [item], base: item.filename.replace(/\.gguf$/i, '') };
  }

  // Repo id — resolve the .gguf file(s) from the tree.
  const r = await fetch('https://huggingface.co/api/models/' + repo + '/tree/main');
  if (!r.ok) throw new Error('HF repo not found: HTTP ' + r.status);
  const files = await r.json();
  const ggufs = files.filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path));
  if (!ggufs.length) throw new Error('No .gguf files found in repo ' + repo);

  const nonSharded = ggufs.filter((f) => !/-of-\d{5}\.gguf$/i.test(f.path));
  if (nonSharded.length) {
    const item = toItem(nonSharded[0].path);
    return { files: [item], base: item.filename.replace(/\.gguf$/i, '') };
  }

  // All sharded: pick the first shard's base and download the full set.
  const SHARD_RE = /^(.*?)-(\d{5})-of-(\d{5})\.gguf$/i;
  const first = ggufs[0].path;
  const m = first.match(/(^|\/)([^/]+)-0*1-of-\d{5}\.gguf$/i);
  const base = m ? m[2] : first.split('/').pop().replace(SHARD_RE, '$1');
  const items = ggufs
    .filter((f) => f.path.includes(base))
    .map((f) => ({ ...toItem(f.path), path: f.path }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  if (!items.length) throw new Error('Could not resolve shards for ' + repo);
  return { files: items, base: base.replace(/\.gguf$/i, '') };
}

async function downloadModel(spec, onProgress) {
  const { files, base } = await resolveModelDownload(spec);
  const filenames = [];
  let grandTotal = 0;
  let grandDone = 0;

  console.log('  ⬇  Downloading model ' + base + ' …');

  for (const item of files) {
    const dest = join(MODELS_DIR, item.filename);
    const tmp = dest + '.part';
    console.log('     ' + item.url);

    const r = await fetch(item.url, { redirect: 'follow' });
    if (!r.ok) throw new Error('Download failed: HTTP ' + r.status + ' for ' + item.filename);
    const total = parseInt(r.headers.get('content-length') || '0', 10);
    grandTotal += total;
    let downloaded = 0;

    const ws = createWriteStream(tmp);
    const reader = r.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value.length;
        grandDone += value.length;
        if (onProgress) onProgress({ downloaded: grandDone, total: grandTotal || 0, filename: item.filename });
        if (!ws.write(Buffer.from(value))) {
          await new Promise((resolve) => ws.once('drain', resolve));
        }
      }
    } finally {
      await new Promise((resolve) => ws.end(resolve));
    }
    if (total > 0 && downloaded < total) {
      try { existsSync(tmp) && unlinkSync(tmp); } catch {}
      throw new Error('Download incomplete: ' + downloaded + '/' + total + ' bytes');
    }
    try { renameSync(tmp, dest); } catch (e) { throw new Error('Could not finalize download: ' + e.message); }
    filenames.push(item.filename);
    console.log('  ✅  Saved ' + item.filename + ' (' + (downloaded / 1e9).toFixed(2) + ' GB)');
  }

  return { base, filenames };
}

async function startTunnel() {
  if (spawnCloudflared()) return;
  console.log('\n  ⚠  cloudflared not found — starting LOCAL while downloading it…');
  try {
    cfg.cloudflaredPath = await downloadCloudflared();
    spawnCloudflared();
  } catch (e) {
    console.log('  ⚠  Could not download cloudflared: ' + e.message);
    console.log('     Install it, then run:  npm run tunnel');
  }
}

// ------------------------------------------------------------------ bootstrap
const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('Request error:', e);
    try { sendJSON(res, 500, { error: e.message }); } catch {}
  });
});

server.on('error', (e) => {
  log('Server error:', e.message);
  process.exitCode = 1;
});

server.listen(cfg.port, cfg.host, async () => {
  console.log('\n  ⚡ Local AI Chat  ·  OpenAI-compatible server');
  console.log('  ───────────────────────────────────────────────');
  console.log('  Chat UI         : http://localhost:' + cfg.port);
  console.log('  OpenAI base URL : http://localhost:' + cfg.port + '/v1');
  console.log('  Provider        : ' + (cfg.aiProvider || 'ollama'));
  console.log('  Backend         : ' + (isCloudProvider() ? openaiBase() : cfg.ollamaUrl));
  console.log('  Mode            : ' + cfg.mode + (cfg.authToken ? '  (auth token enabled)' : ''));
  console.log('  Models folder   : ' + MODELS_DIR);
  if (cfg.mode === 'tunnel') await startTunnel();
  // Auto-register any .gguf files dropped into the models folder (local providers).
  if (!isCloudProvider()) {
    try { await autoRegisterLocalModels(); } catch (e) { log('Local model auto-register error:', e); }
  }
  console.log('  Press Ctrl+C to stop\n');
});
