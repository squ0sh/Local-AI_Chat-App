import { createHash, createPrivateKey, sign } from 'crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { canonicalManifest, pubkeyFingerprint, verifyManifestSignature } from '../lib/capsule-integrity.mjs';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNING_KEY = process.env.CAPSULE_SIGNING_KEY || join(homedir(), '.capsule-signing', 'key.pem');
const trackedFiles = [
  'server.mjs',
  'index.html',
  'capsule-ui.js',
  'capsule.json',
  'skills.json',
  'start-portable.sh',
  'start-portable.cmd',
  'package.json',
  'capsule-signing-pub.pem',
  'lib/capsule-integrity.mjs',
  'lib/capsule-vault.mjs',
  'lib/chat-store.mjs',
  'lib/rate-limit.mjs',
  'lib/research-engine.mjs',
  'lib/resumable-ollama-pull.mjs',
  'lib/vendor/qrcode-generator.mjs',
  'tools/model-cli.mjs',
  'tools/generate-integrity.mjs',
  'tools/package-runtimes.mjs',
  'tools/ollama-health.mjs',
  'tools/sign-capsule.mjs',
  'tools/update-cloudflared-manifest.mjs',
  'cloud/worker.mjs',
  'cloud/wrangler.toml',
  'cloud/cloudflared-manifest.json',
];

function filesUnder(relativeDir) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(join(appDir, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path === 'runtime/platforms' || path.startsWith('runtime/.platforms-')) continue;
        visit(path);
      } else found.push(path);
    }
  };
  visit(relativeDir);
  return found.sort();
}

trackedFiles.push(...filesUnder('runtime'));

const files = trackedFiles.map((path) => {
  const file = join(appDir, path);
  const bytes = statSync(file).size;
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  return { path, bytes, sha256 };
});

const manifest = {
  schema_version: 1,
  algorithm: 'sha256',
  generated_at: new Date().toISOString(),
  files,
};

try {
  const pem = readFileSync(SIGNING_KEY, 'utf8');
  const key = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
  const pub = readFileSync(join(appDir, 'capsule-signing-pub.pem'), 'utf8');
  manifest.signature = {
    algorithm: 'ed25519',
    pubkey_sha256: pubkeyFingerprint(pub),
    value: sign(null, Buffer.from(canonicalManifest(manifest), 'utf8'), key).toString('base64'),
  };
  if (!verifyManifestSignature(manifest, pub).ok) throw new Error('self-check failed');
  console.log('Signed integrity manifest with ' + SIGNING_KEY);
} catch (error) {
  console.warn('⚠ Manifest NOT signed: ' + error.message);
}

writeFileSync(join(appDir, 'capsule-integrity.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Recorded ${files.length} Capsule files.`);
