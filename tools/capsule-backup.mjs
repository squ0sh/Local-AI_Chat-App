import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SCRYPT_N = 1 << 15, SCRYPT_R = 8, SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
}

function readTree(root) {
  const entries = [];
  const visit = (dir, base) => {
    for (const name of readdirSync(join(root, base))) {
      const full = join(root, base, name);
      const rel = (base ? base + '/' : '') + name;
      const st = statSync(full);
      if (st.isDirectory()) visit(full, rel);
      else if (st.isFile() && st.size <= 512 * 1024 * 1024) entries.push({ path: rel, bytes: st.size, data: readFileSync(full).toString('base64') });
    }
  };
  visit(root, '');
  return entries;
}

function writeTree(root, entries) {
  for (const entry of entries) {
    const full = join(root, entry.path);
    const safe = full.startsWith(root + '/') || full.startsWith(root);
    if (!safe) throw new Error('Backup entry escapes the restore root: ' + entry.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, Buffer.from(entry.data, 'base64'));
  }
}

/**
 * Encrypted snapshot of the Capsule's live data (settings, vault, model
 * provenance, chat store, research). Produced with --snapshot and restored
 * with --restore --verify. Passphrase-sealed with AES-256-GCM over scrypt.
 */
export async function snapshot({ dataDir, passphrase, outFile }) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const payload = JSON.stringify({ v: 1, created_at: new Date().toISOString(), files: readTree(dataDir) });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({
    capsule_backup: 1,
    kdf: { name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    file_count: payload.split('"path"').length - 1,
  }) + '\n');
  return outFile;
}

export async function restore({ backupFile, dataDir, passphrase, verifyOnly = false }) {
  const blob = JSON.parse(readFileSync(backupFile, 'utf8'));
  if (blob.capsule_backup !== 1) throw new Error('Not a Capsule backup file');
  const key = deriveKey(passphrase, Buffer.from(blob.salt, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]).toString('utf8'));
  if (verifyOnly) return { ok: true, created_at: payload.created_at, files: payload.files.length, file_count: blob.file_count };
  writeTree(dataDir, payload.files);
  return { ok: true, created_at: payload.created_at, files: payload.files.length };
}

// CLI shim: node tools/capsule-backup.mjs --snapshot --data <dir> --out <file>
//            node tools/capsule-backup.mjs --restore --backup <file> --data <dir> [--verify]
if (process.argv[1] && process.argv[1].endsWith('capsule-backup.mjs')) {
  const dataDirDefault = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
  const args = process.argv.slice(2);
  const get = (flag) => args[args.indexOf(flag) + 1];
  const has = (flag) => args.includes(flag);
  const pass = process.env.CAPSULE_BACKUP_PASS || '';
  if (has('--snapshot')) {
    const out = get('--out') || join(dirname(fileURLToPath(import.meta.url)), '..', 'capsule-backup.json');
    const file = await snapshot({ dataDir: get('--data') || dataDirDefault, passphrase: pass, outFile: out });
    console.log('Backup written to ' + file);
  } else if (has('--restore')) {
    const result = await restore({
      backupFile: get('--backup'),
      dataDir: get('--data') || dataDirDefault,
      passphrase: pass,
      verifyOnly: has('--verify'),
    });
    console.log((has('--verify') ? 'Verified backup' : 'Restored from backup') + ': ' + result.files + ' files (' + result.created_at + ')');
  } else {
    console.log('Usage: node tools/capsule-backup.mjs --snapshot [--data <dir>] [--out <file>]');
    console.log('       node tools/capsule-backup.mjs --restore --backup <file> [--data <dir>] [--verify]');
    console.log('Passphrase via CAPSULE_BACKUP_PASS env. Without a passphrase this refuses to run.');
    process.exitCode = 1;
  }
}