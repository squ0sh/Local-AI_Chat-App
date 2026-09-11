import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const MAX_WORKSPACE_BYTES = 6 * 1024 * 1024;

function writeAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
  writeFileSync(tmp, data);
  if (process.platform !== 'win32') { try { chmodSync(tmp, 0o600); } catch {} }
  renameSync(tmp, file);
}

function loadOrCreateKey(dataDir) {
  const keyFile = join(dataDir, 'chat-store.key');
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(keyFile)) {
    try { return Buffer.from(readFileSync(keyFile, 'utf8').trim().split('\n')[0] || '', 'base64'); } catch {}
  }
  const key = randomBytes(KEY_BYTES);
  writeAtomic(keyFile, key.toString('base64') + '\n');
  return key;
}

function seal(plaintext, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function unseal(blob, key) {
  if (!blob || blob.v !== 1) throw new Error('Unsupported chat store blob');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]).toString('utf8');
}

const SAFE_ID = /^[a-zA-Z0-9._-]{1,64}$/;

function sanitizeChat(chat) {
  const id = String(chat.id || '');
  const telegram = String(chat.title || 'New chat').slice(0, 200);
  const messages = (Array.isArray(chat.messages) ? chat.messages : [])
    .slice(0, 1000)
    .map((m) => {
      const role = m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
      const content = Array.isArray(m.content)
        ? m.content.map((part) => {
          if (!part || typeof part !== 'object') return null;
          if (part.type === 'image_url' && typeof part.image_url === 'object') {
            const url = String(part.image_url.url || '');
            if (url.startsWith('data:') && url.length < 5_000_000) return { type: 'image_url', image_url: { url } };
            return null;
          }
          return { type: 'text', text: String(part.text || '').slice(0, 200_000) };
        }).filter(Boolean)
        : String(m.content ?? '').slice(0, 200_000);
      return { role, content };
    });
  return {
    id: SAFE_ID.test(id) ? id : 'chat-' + randomBytes(8).toString('hex'),
    title: telegram,
    createdAt: Number(chat.createdAt) || Date.now(),
    updatedAt: Number(chat.updatedAt) || Date.now(),
    model: String(chat.model || '').slice(0, 300),
    systemPrompt: String(chat.systemPrompt || '').slice(0, 20_000),
    projectId: String(chat.projectId || '').slice(0, 80),
    privacy: ['local', 'cloud'].includes(chat.privacy) ? chat.privacy : 'local',
    messages,
  };
}

function sanitizeWorkspace(input) {
  const workspace = (input && typeof input === 'object') ? input : {};
  const chats = Array.isArray(workspace.chats) ? workspace.chats.slice(0, 500).map(sanitizeChat) : [];
  const projects = Array.isArray(workspace.projects) ? workspace.projects.slice(0, 200).map((p) => ({
    id: String(p.id || 'project-' + randomBytes(8).toString('hex')).slice(0, 80),
    name: String(p.name || 'Project').slice(0, 200),
    createdAt: Number(p.createdAt) || Date.now(),
    documents: Array.isArray(p.documents) ? p.documents.slice(0, 200).map((d) => ({
      id: String(d.id || '').slice(0, 80),
      name: String(d.name || '').slice(0, 200),
      text: String(d.text || '').slice(0, 1_500_000),
    })) : [],
  })) : [];
  return {
    chats,
    projects,
    activeId: String(workspace.activeId || (chats[0]?.id || '')).slice(0, 80),
  };
}

/**
 * Encrypted at-rest chat workspace. Everything is sealed with a per-install
 * AES-256-GCM key stored next to the data (0600), so chat history on disk is
 * unreadable without the file and app. The passphrase Vault remains the
 * stronger, user-chosen layer on top of this.
 */
export class ChatStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = join(dataDir, 'workspace.json');
    this.key = loadOrCreateKey(dataDir);
  }

  get() {
    return this._cached ?? this.reload();
  }

  reload() {
    this._cached = null;
    if (!existsSync(this.file)) return null;
    let blob;
    try { blob = JSON.parse(readFileSync(this.file, 'utf8')); } catch { return null; }
    try {
      this._cached = JSON.parse(unseal(blob, this.key));
      return this._cached;
    } catch { return null; }
  }

  save(workspace) {
    const clean = sanitizeWorkspace(workspace);
    const payload = JSON.stringify(clean);
    if (Buffer.byteLength(payload) > MAX_WORKSPACE_BYTES) throw new Error('Chat workspace exceeds the store limit');
    writeAtomic(this.file, JSON.stringify(seal(payload, this.key)) + '\n');
    this._cached = clean;
    return clean;
  }
}