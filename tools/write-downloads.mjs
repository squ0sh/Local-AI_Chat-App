import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { nodeArtifacts, ollamaArtifacts, nodeArchiveUrl, ollamaArchiveUrl } from '../lib/runtime-pins.mjs';

// The smallest size a healthy bundled binary can plausibly be. Truncated or
// zeroed downloads of a USB handoff are the common failure mode; a real
// Node/Ollama executable is tens of megabytes at minimum.
export const MIN_BINARY_BYTES = 5 * 1024 * 1024;

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function binaryPath(platform, kind) {
  const win = platform.startsWith('win32-');
  if (kind === 'node') {
    const leaf = win ? 'node.exe' : 'node';
    return ['runtime', 'platforms', platform, win ? 'node' : 'node/bin', leaf];
  }
  return ['runtime', 'platforms', platform, 'ollama', win ? 'ollama.exe' : 'ollama'];
}

function hashOrDash(path) {
  return existsSync(path) ? sha256File(path) : '-';
}

/**
 * Writes runtime/downloads.txt — a tab-separated table the portable launchers
 * read (plain text so it is parseable before Node is available):
 *   platform kind url archive_sha256 binary_sha256 min_bytes
 * binary_sha256 is the sha256 of the extracted executable as packaged by
 * tools/package-runtimes.mjs ('-' when it cannot be computed here), and
 * min_bytes is the sanity floor for the extracted binary size.
 */
export function writeDownloadsFile(appDir) {
  const lines = ['# platform\tkind\turl\tarchive_sha256\tbinary_sha256\tmin_bytes'];
  const platforms = Object.keys(nodeArtifacts).sort();
  for (const platform of platforms) {
    const [nodeArtifact, nodeSha] = nodeArtifacts[platform];
    const [ollamaArtifact, ollamaSha] = ollamaArtifacts[platform.startsWith('darwin') ? 'darwin' : platform];
    const nodeBinary = resolve(appDir, ...binaryPath(platform, 'node'));
    const ollamaBinary = resolve(appDir, ...binaryPath(platform, 'ollama'));
    lines.push([platform, 'node', nodeArchiveUrl(nodeArtifact), nodeSha, hashOrDash(nodeBinary), MIN_BINARY_BYTES].join('\t'));
    lines.push([platform, 'ollama', ollamaArchiveUrl(ollamaArtifact), ollamaSha, hashOrDash(ollamaBinary), MIN_BINARY_BYTES].join('\t'));
  }
  writeFileSync(resolve(appDir, 'runtime', 'downloads.txt'), lines.join('\n') + '\n');
}

// Runs when invoked directly (node tools/write-downloads.mjs) and stays
// importable by tools/package-runtimes.mjs.
const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  writeDownloadsFile(join(dirname(THIS_FILE), '..'));
}