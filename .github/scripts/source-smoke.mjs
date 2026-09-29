// Native-OS pre-publication smoke test. This tests the signed checkout and
// pinned runtime downloads, not the unpublished ZIP bytes. The ZIPs are
// checked locally and can be tested by release-smoke.mjs after publication.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const platform = process.env.RELEASE_PLATFORM;
const wanted = { linux: 'linux-x64', win32: 'win32-x64', darwin: 'darwin-x64' }[process.platform];
if (!wanted || platform !== wanted || process.arch !== 'x64') throw new Error(`Wrong runner: ${process.platform}-${process.arch} cannot test ${platform}`);
const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function checked(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
  return (result.stdout || '').trim();
}

console.log(checked(process.execPath, [join(app, 'tools', 'verify-release.mjs')]));
const existingOllama = await fetch('http://127.0.0.1:11435/api/version', { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false);
if (existingOllama) throw new Error('Runner already has Ollama on port 11435; bundled-engine startup cannot be proven');
const port = process.platform === 'win32' ? 5173 : await new Promise((resolvePort, reject) => {
  const listener = createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => { const chosen = listener.address().port; listener.close(() => resolvePort(chosen)); });
});
const env = { ...process.env, LOCAL_AI_NO_BROWSER: '1', LOCAL_AI_AUTO_DOWNLOADS: '1', LOCAL_AI_VERIFY_RUNTIMES: '1', LOCAL_AI_PORT: String(port) };
delete env.CAPSULE_DEV_MODE;
const command = process.platform === 'win32' ? 'cmd.exe' : 'bash';
const args = process.platform === 'win32' ? ['/d', '/c', join(app, 'start-portable.cmd'), '--verify-runtimes'] : [join(app, 'start-portable.sh'), '--verify-runtimes'];
const launcher = spawn(command, args, { cwd: app, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
for (const stream of [launcher.stdout, launcher.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk).slice(-20000); });
try {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 240; i += 1) {
    if (launcher.exitCode !== null) throw new Error(`Launcher exited early (${launcher.exitCode}):\n${logs}`);
    try {
      const health = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) }).then((response) => response.json());
      const status = await fetch(base + '/api/release/status', { signal: AbortSignal.timeout(1500) }).then((response) => response.json());
      if (health.ollama && status.state === 'verified') { ready = true; break; }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  if (!ready || !logs.includes('Starting portable Ollama')) throw new Error(`Bundled runtime or signed app did not become ready:\n${logs}`);

  const runtime = join(app, 'runtime', 'platforms', platform);
  const bins = [['node', join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')], ['ollama', join(runtime, 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama')]];
  const rows = readFileSync(join(app, 'runtime', 'downloads.txt'), 'utf8').split('\n');
  for (const [kind, binary] of bins) {
    const row = rows.find((line) => line.startsWith(`${platform}\t${kind}\t`))?.split('\t');
    const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
    if (!row || digest !== row[4]) throw new Error(`Downloaded ${kind} does not match its signed runtime pin`);
    console.log(`${kind} native runtime: ${checked(binary, ['--version'])}`);
  }
  console.log(`${platform}: pinned runtime, portable launcher, local engine, and verified API passed`);
} finally {
  if (launcher.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-launcher.pid, 'SIGTERM'); } catch {} }
  }
}
