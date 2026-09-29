// Tests desktop Exec parsing with the actual installed GIO implementation.
// Does not mark anything trusted and does not claim a file-manager click test.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
const source = resolve(process.argv[2] || 'Local AI Chat.desktop');
const root = mkdtempSync(join(tmpdir(), 'capsule-desktop-probe-'));
try {
  const app = join(root, 'Folder space ü $dollar "quote" 100%');
  mkdirSync(app);
  const marker = join(app, 'launched');
  copyFileSync(source, join(app, 'Local AI Chat.desktop'));
  writeFileSync(join(app, 'start-portable.sh'), '#!/bin/bash\nprintf "%s" "$(realpath -- "$0")" > "$CAPSULE_DESKTOP_PROBE_MARKER"\n', { mode: 0o755 });
  const checked = spawnSync('desktop-file-validate', [join(app, 'Local AI Chat.desktop')], { encoding: 'utf8' });
  if (checked.status !== 0) throw new Error('Desktop file validation failed: ' + checked.stdout + checked.stderr);
  const run = spawnSync('gio', ['launch', join(app, 'Local AI Chat.desktop')], { cwd: '/', env: { ...process.env, CAPSULE_DESKTOP_PROBE_MARKER: marker }, encoding: 'utf8' });
  if (run.status !== 0) throw new Error('GIO launch failed: ' + run.stderr);
  for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(marker)) throw new Error('Desktop launch did not reach the shell launcher: ' + run.stdout + run.stderr);
  if (readFileSync(marker, 'utf8') !== join(app, 'start-portable.sh')) throw new Error('Wrong launcher path');
  mkdirSync(join(app, 'tools'));
  copyFileSync(join(dirname(source), 'tools/register-menu-entry.sh'), join(app, 'tools/register-menu-entry.sh'));
  const env = { ...process.env, XDG_DATA_HOME: join(root, 'menu'), CAPSULE_DESKTOP_PROBE_MARKER: marker };
  const install = spawnSync('bash', [join(app, 'tools/register-menu-entry.sh')], { env, encoding: 'utf8' });
  if (install.status !== 0) throw new Error('Menu registration failed: ' + install.stderr);
  rmSync(marker);
  const entry = join(env.XDG_DATA_HOME, 'applications/local-ai-capsule.desktop');
  if (spawnSync('desktop-file-validate', [entry]).status !== 0) throw new Error('Menu entry is invalid');
  if (spawnSync('gio', ['launch', entry], { cwd: '/', env }).status !== 0) throw new Error('Menu entry launch failed');
  for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== join(app, 'start-portable.sh')) throw new Error('Menu entry reached wrong launcher');
  console.log('PASS: desktop-file-validate + GIO Exec dispatch from unrelated cwd, including spaces, Unicode, quotes, dollar and percent characters. File-manager trust/click not tested.');
} finally { rmSync(root, { recursive: true, force: true }); }
