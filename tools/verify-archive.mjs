import { readFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { pubkeyFingerprint } from '../lib/capsule-integrity.mjs';
import { sha256, verifyChecksums } from '../lib/release-package.mjs';

const archive = process.argv[2] ? resolve(process.argv[2]) : '';
if (!archive || !/^Capsule-v[0-9A-Za-z.-]+-(?:linux|darwin|win32)-(?:x64|arm64)\.zip$/.test(basename(archive))) {
  throw new Error('Usage: node tools/verify-archive.mjs Capsule-vX.Y.Z-PLATFORM.zip');
}
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = readFileSync(join(appDir, 'capsule-signing-pub.pem'), 'utf8');
const checksum = readFileSync(archive + '.sha256', 'utf8');
const signature = readFileSync(archive + '.sha256.sig', 'utf8');
if (!verifyChecksums(checksum, signature, pub)) throw new Error('Detached release signature is invalid');
const expected = `${sha256(readFileSync(archive))}  ${basename(archive)}\n`;
if (checksum !== expected) throw new Error('Archive checksum does not match the signed checksum');
console.log('Archive signature and checksum verified. Release key fingerprint: ' + pubkeyFingerprint(pub));
