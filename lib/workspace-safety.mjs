import { existsSync, lstatSync, realpathSync } from 'fs';
import { basename, join, relative, resolve, sep } from 'path';

const BLOCKED_SEGMENTS = new Set(['.git', '.portable', 'node_modules']);
const BLOCKED_FILES = new Set([
  '.env', 'ai_settings.env', 'capsule-vault.json', 'capsule-cloud-vault.json',
  'chat-store.key', 'users.json',
]);

function isSensitivePath(parts) {
  if (parts.some((part) => BLOCKED_SEGMENTS.has(part.toLowerCase()))) return true;
  const name = basename(parts.join('/')).toLowerCase();
  return BLOCKED_FILES.has(name) || name.endsWith('.pem') || name.endsWith('.key');
}

export function safeWorkspacePath(workspaceRoot, requested = '.', options = {}) {
  const raw = String(requested || '.');
  if (raw.includes('\0') || raw.includes('\\')) throw new Error('Path is not a portable workspace path');
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (isSensitivePath(parts)) throw new Error('Path is protected from agent access');

  const root = realpathSync(workspaceRoot);
  const target = resolve(root, raw);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep)) throw new Error('Path is outside workspace');
  if (!rel && options.allowRoot === false) throw new Error('Choose a file or subdirectory inside the workspace');

  let cursor = root;
  const normalizedParts = rel ? rel.split(sep) : [];
  for (let index = 0; index < normalizedParts.length; index += 1) {
    cursor = join(cursor, normalizedParts[index]);
    if (!existsSync(cursor)) continue;
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in agent paths');
    if (index < normalizedParts.length - 1 && !info.isDirectory()) throw new Error('A path parent is not a directory');
    const resolved = realpathSync(cursor);
    const resolvedRel = relative(root, resolved);
    if (resolvedRel === '..' || resolvedRel.startsWith('..' + sep)) throw new Error('Path resolves outside workspace');
  }
  if (!options.allowMissing && !existsSync(target)) throw new Error('Path does not exist');
  return { path: target, relative: rel.split(sep).join('/') };
}
