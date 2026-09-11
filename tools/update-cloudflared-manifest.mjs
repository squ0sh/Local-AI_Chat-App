import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Refreshes cloud/cloudflared-manifest.json with a pinned cloudflared release
// and per-platform SHA-256 checksums (from GitHub's asset `digest` fields).
// Usage:
//   node tools/update-cloudflared-manifest.mjs            # pin latest stable
//   node tools/update-cloudflared-manifest.mjs 2026.9.0    # pin an exact tag
// Run this only when you deliberately want to trust a newer mixed-version
// build of cloudflared; then audit the printed checksums by hand.

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(appDir, 'cloud', 'cloudflared-manifest.json');

const assetKeys = new Map([
  ['cloudflared-linux-amd64', 'linux-x64'],
  ['cloudflared-linux-arm64', 'linux-arm64'],
  ['cloudflared-darwin-amd64.tgz', 'darwin-x64'],
  ['cloudflared-darwin-arm64.tgz', 'darwin-arm64'],
  ['cloudflared-windows-amd64.exe', 'win32-x64'],
]);

async function fetchRelease(tag) {
  const url = tag
    ? `https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${tag}`
    : 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
  const r = await fetch(url, { headers: { 'User-Agent': 'Capsule-local-ai-chat' } });
  if (!r.ok) throw new Error(`GitHub API ${url} → HTTP ${r.status}`);
  return r.json();
}

const exact = process.argv[2];
const release = await fetchRelease(exact);
const version = release.tag_name;
const assets = {};
for (const asset of release.assets || []) {
  const key = assetKeys.get(asset.name);
  if (!key) continue;
  const digest = String(asset.digest || '');
  const sha256 = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Missing/invalid sha256 digest for ${asset.name}`);
  assets[key] = { asset: asset.name, sha256 };
}
if (Object.keys(assets).length === 0) throw new Error(`No known platform assets found in release ${version}`);

const manifest = {
  version,
  base_url: 'https://github.com/cloudflare/cloudflared/releases/download/{version}/{asset}',
  assets,
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Pinned cloudflared ${version} → ${Object.keys(assets).length} platforms (${manifestPath}).`);
console.log('  ' + Object.values(assets).map((a) => `${a.asset}: ${a.sha256.slice(0, 16)}…`).join('\n  '));
console.log('\n⚠  If any checksum changed from the previous pin, verify it independently before proceeding.');