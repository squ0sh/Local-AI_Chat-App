import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const platform = process.env.RELEASE_PLATFORM;
const releaseDir = process.env.RELEASE_DIR;
const wanted = { linux: 'linux-x64', win32: 'win32-x64', darwin: 'darwin-x64' }[process.platform];
if (!wanted || platform !== wanted || process.arch !== 'x64') throw new Error(`Wrong runner: ${process.platform}-${process.arch} cannot test ${platform}`);
if (!releaseDir) throw new Error('RELEASE_DIR is required');

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const version = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version;
const name = `Capsule-v${version}-${platform}.zip`;
const archive = join(releaseDir, name);
for (const suffix of ['', '.sha256', '.sha256.sig', '.release.json']) {
  if (!existsSync(archive + suffix)) throw new Error(`Missing release asset: ${name + suffix}`);
}
const assets = readdirSync(releaseDir);
if (assets.length !== 4 || assets.some((asset) => !asset.startsWith(name))) throw new Error('Release download contains unexpected assets');

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
  return (result.stdout || '').trim();
}

console.log(checked(process.execPath, [join(checkout, 'tools/verify-archive.mjs'), archive]));
const metadata = JSON.parse(readFileSync(archive + '.release.json', 'utf8'));
if (metadata.platform !== platform || metadata.archive !== name || metadata.version !== version) throw new Error('Release metadata does not match this platform/version');

const root = mkdtempSync(join(tmpdir(), 'capsule-x64-smoke-'));
let launcher;
try {
  if (process.platform === 'win32') {
    const quoted = (value) => `'${value.replaceAll("'", "''")}'`;
    checked('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${quoted(archive)} -DestinationPath ${quoted(root)} -Force`]);
  } else checked('unzip', ['-q', archive, '-d', root]);

  const app = join(root, 'Capsule');
  const runtime = join(app, 'runtime', 'platforms');
  const platformDirs = readdirSync(runtime);
  if (platformDirs.length !== 1 || platformDirs[0] !== platform) throw new Error(`ZIP has wrong platform runtimes: ${platformDirs.join(', ')}`);
  const nodeBin = join(runtime, platform, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const ollamaBin = join(runtime, platform, 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama');
  const pins = readFileSync(join(app, 'runtime', 'downloads.txt'), 'utf8').split('\n');
  for (const [kind, binary] of [['node', nodeBin], ['ollama', ollamaBin]]) {
    const row = pins.find((line) => line.startsWith(`${platform}\t${kind}\t`))?.split('\t');
    const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
    if (!row || digest !== row[4]) throw new Error(`Bundled ${kind} does not match its signed runtime pin`);
  }
  console.log('Bundled Node:', checked(nodeBin, ['--version']));
  console.log('Bundled Ollama:', checked(ollamaBin, ['--version']));
  console.log(checked(nodeBin, [join(app, 'tools', 'verify-release.mjs')], { env: { ...process.env, CAPSULE_DEV_MODE: '' } }));

  const port = process.platform === 'win32' ? 5173 : await new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => { const chosen = listener.address().port; listener.close(() => resolvePort(chosen)); });
  });
  const existingOllama = await fetch('http://127.0.0.1:11435/api/version', { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false);
  if (existingOllama) throw new Error('Runner already has an Ollama service on port 11435; cannot prove the bundled engine started');
  const env = { ...process.env, LOCAL_AI_NO_BROWSER: '1', LOCAL_AI_VERIFY_RUNTIMES: '1', LOCAL_AI_PORT: String(port) };
  delete env.CAPSULE_DEV_MODE;
  const command = process.platform === 'win32' ? 'cmd.exe' : 'bash';
  const args = process.platform === 'win32' ? ['/d', '/c', join(app, 'start-portable.cmd'), '--verify-runtimes'] : [join(app, 'start-portable.sh'), '--verify-runtimes'];
  launcher = spawn(command, args, { cwd: app, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  for (const stream of [launcher.stdout, launcher.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk).slice(-16000); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    if (launcher.exitCode !== null) throw new Error(`Launcher exited early (${launcher.exitCode}):\n${logs}`);
    try {
      const health = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      const status = await fetch(base + '/api/release/status', { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      if (health.ollama && status.state === 'verified') { ready = true; break; }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  if (!ready || !logs.includes('Starting portable Ollama')) throw new Error(`Portable launcher did not start its bundled engine and reach verified, engine-ready state:\n${logs}`);
  console.log(`${platform}: portable launcher, bundled engine, and verified UI API passed`);
} finally {
  if (launcher?.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-launcher.pid, 'SIGTERM'); } catch {} }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
