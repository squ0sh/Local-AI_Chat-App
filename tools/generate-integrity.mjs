import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const trackedFiles = [
  'server.mjs',
  'index.html',
  'capsule-ui.js',
  'capsule.json',
  'skills.json',
  'start-portable.sh',
  'start-portable.cmd',
  'package.json',
  'lib/capsule-integrity.mjs',
  'lib/capsule-vault.mjs',
  'lib/research-engine.mjs',
  'lib/resumable-ollama-pull.mjs',
  'lib/vendor/qrcode-generator.mjs',
  'tools/model-cli.mjs',
  'tools/generate-integrity.mjs',
  'tools/package-runtimes.mjs',
  'tools/ollama-health.mjs',
  'cloud/worker.mjs',
  'cloud/wrangler.toml',
];

function filesUnder(relativeDir) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(join(appDir, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else found.push(path);
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

writeFileSync(join(appDir, 'capsule-integrity.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Recorded ${files.length} Capsule files.`);
