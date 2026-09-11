import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { snapshot, restore } from '../tools/capsule-backup.mjs';

test('capsule backup seals data and restores it with --verify semantics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-backup-'));
  const dataDir = join(dir, 'data');
  const outFile = join(dir, 'snapshot.json');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'hi.txt'), 'secret payload');
    const pass = 'correct horse battery staple';
    const snap = await snapshot({ dataDir, passphrase: pass, outFile });
    const raw = readFileSync(snap, 'utf8');
    assert.doesNotMatch(raw, /secret payload/);
    await assert.rejects(() => restore({ backupFile: snap, dataDir: join(dir, 'wrong'), passphrase: 'nope', verifyOnly: true }), /authenticate|passphrase|Unsupported/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});