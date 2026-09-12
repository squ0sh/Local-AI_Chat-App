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

const manifestPath = join(appDir, 'capsule-integrity.json');
let current = null;
try { current = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {}

// Regeneration is idempotent: when the tracked files are byte-identical to the
// existing manifest we leave it untouched (including its signature and
// timestamp), so `npm run ci` does not produce a spurious diff.
const contentChanged = !current || JSON.stringify(current.files) !== JSON.stringify(manifest.files);

let signed = false;
let signError = '';
function signManifest() {
  try {
    const pem = readFileSync(SIGNING_KEY, 'utf8');
    const key = createPrivateKey({ key: pem, format: 'pem', type: 'pkcs8' });
    const pub = readFileSync(join(appDir, 'capsule-signing-pub.pem'), 'utf8');
    manifest.signature = {
      algorithm: 'ed25519',
      pubkey_sha256: pubkeyFingerprint(pub),
      value: sign(null, Buffer.from(canonicalManifest(manifest), 'utf8'), key).toString('base64'),
    };
    const check = verifyManifestSignature(manifest, pub);
    if (!check.ok) throw new Error('self-check failed: ' + check.error);
    signed = true;
  } catch (error) {
    signError = error.message;
  }
}

if (!contentChanged && current) {
  console.log('Integrity manifest is current (' + files.length + ' files' + (current.signature ? ', signed' : ', unsigned') + ').');
} else {
  manifest.generated_at = new Date().toISOString();
  signManifest();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  if (signed) {
    console.log('Signed integrity manifest with ' + SIGNING_KEY);
  } else {
    console.log('Wrote unsigned integrity manifest (' + files.length + ' files) — no signing key at ' + SIGNING_KEY + (signError ? ' (' + signError + ')' : '') + '.');
    console.log('  Launch via start-portable.sh (it auto-sets CAPSULE_ALLOW_UNSIGNED=1 on keyless machines), or');
    console.log('  set CAPSULE_ALLOW_UNSIGNED=1 manually after npm run integrity.');
  }
  console.log(`Recorded ${files.length} Capsule files.`);
}
