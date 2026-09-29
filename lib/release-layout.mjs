// Explicit distribution inventory. Source/test inventory is deliberately separate.
export const RELEASE_PLATFORMS = new Set(['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']);
const SHARED = [
  'server.mjs', 'index.html', 'capsule-ui.js', 'capsule.json', 'skills.json',
  'package.json', 'capsule-signing-pub.pem', 'assets/icon.svg',
  'FRIENDS-AND-FAMILY.md', 'SECURITY.md', 'models/README.txt',
  'runtime/README.md', 'runtime/index.json', 'runtime/downloads.txt',
  'runtime/licenses/NODE-LICENSE', 'runtime/licenses/OLLAMA-LICENSE',
  'cloud/cloudflared-manifest.json',
  'lib/agent-loop.mjs', 'lib/capsule-handshake.mjs', 'lib/capsule-integrity.mjs',
  'lib/capsule-memory.mjs', 'lib/capsule-net.mjs', 'lib/capsule-vault.mjs',
  'lib/chat-store.mjs', 'lib/consolidation.mjs', 'lib/escrow.mjs', 'lib/fit-engine.mjs',
  'lib/git-safety.mjs', 'lib/hardware.mjs', 'lib/kokoro-worker.mjs', 'lib/mcp-client.mjs',
  'lib/memory.mjs', 'lib/peer-transport.mjs', 'lib/rate-limit.mjs',
  'lib/release-layout.mjs', 'lib/request-security.mjs', 'lib/research-engine.mjs',
  'lib/resumable-ollama-pull.mjs', 'lib/runtime-pins.mjs', 'lib/telemetry.mjs',
  'lib/user-store.mjs', 'lib/voice.mjs', 'lib/workspace-safety.mjs',
  'lib/vendor/jsqr-core.cjs', 'lib/vendor/jsqr.mjs', 'lib/vendor/qrcode-generator.mjs',
  'lib/vendor/sound-modem.cjs', 'lib/vendor/sound-modem.mjs',
  'tools/verify-release.mjs', 'tools/ollama-health.mjs', 'tools/model-cli.mjs',
  'tools/capsule-backup.mjs',
];
const PLATFORM = {
  win32: ['start-portable.cmd', 'tools/install-portable-runtime.ps1', 'tools/service.cmd', 'START HERE - Windows.txt'],
  darwin: ['Local AI Chat.command', 'start-portable.sh', 'tools/service.sh', 'START HERE - Mac.txt'],
  linux: ['Local AI Chat.desktop', 'start-portable.sh', 'tools/register-menu-entry.sh', 'tools/service.sh', 'START HERE - Linux.txt'],
};
export function distributionPaths(platform) {
  if (!RELEASE_PLATFORMS.has(platform)) throw new Error('Unsupported distribution platform');
  return [...SHARED, ...PLATFORM[platform.split('-')[0]]].sort();
}

export function assertDistributionContents(paths, platform) {
  const required = [...distributionPaths(platform), 'capsule-integrity.json'];
  const allowed = new Set(required);
  const files = new Set(paths);
  if (files.size !== paths.length) throw new Error('Duplicate distribution entries');
  for (const path of required) if (!files.has(path)) throw new Error('Missing distribution file: ' + path);
  const prefix = `runtime/platforms/${platform}/`;
  for (const path of files) {
    if (allowed.has(path)) continue;
    if (!path.startsWith(prefix) || /(?:^|\/)(?:\.[^/]*|test|tests|data|logs|coverage|node_modules|credentials?[^/]*|secrets?[^/]*|tokens?[^/]*)(?:\/|$)/i.test(path)
      || /\.(?:pem|key|p12|pfx|seed|zip|log|tmp|bak)$/i.test(path)
      || /(?:^|\/)(?:Thumbs\.db|id_rsa|id_ed25519)$/i.test(path)) throw new Error('Unexpected distribution file: ' + path);
  }
  for (const binary of platform.startsWith('win32') ? ['node/node.exe', 'ollama/ollama.exe'] : ['node/bin/node', 'ollama/ollama']) {
    if (!files.has(prefix + binary)) throw new Error('Missing platform runtime: ' + binary);
  }
}
