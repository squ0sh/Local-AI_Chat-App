import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { safeWorkspacePath } from '../lib/workspace-safety.mjs';
import { agentWriteFile } from '../lib/agent-loop.mjs';

test('workspace paths reject traversal, protected state, and symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-'));
  const outside = mkdtempSync(join(tmpdir(), 'agent-outside-'));
  try {
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'ok.txt'), 'ok');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'leak'), 'dir');
    assert.equal(safeWorkspacePath(root, 'notes/ok.txt').relative, 'notes/ok.txt');
    assert.throws(() => safeWorkspacePath(root, '../secret.txt'), /outside/i);
    assert.throws(() => safeWorkspacePath(root, '.git/config', { allowMissing: true }), /protected/i);
    assert.throws(() => safeWorkspacePath(root, '.portable/data/ai_settings.env', { allowMissing: true }), /protected/i);
    assert.throws(() => safeWorkspacePath(root, 'leak/secret.txt'), /symbolic/i);

    const write = agentWriteFile(root, 'leak/secret.txt', 'changed');
    assert.match(write.error, /symbolic/i);
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret');
    assert.equal(existsSync(join(root, '.portable')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
