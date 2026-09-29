import { spawnSync } from 'child_process';
import { createPrivateKey, sign } from 'crypto';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, chmodSync, statSync, utimesSync, readdirSync, renameSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildReleaseManifest, canonicalManifest, portableIntegrityReport, pubkeyFingerprint } from '../lib/capsule-integrity.mjs';
import { checksumLine, releaseFiles, RELEASE_PLATFORMS, sha256, signChecksums } from '../lib/release-package.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? '' : args[i + 1] || ''; };
const platform = value('--platform');
const outDir = resolve(value('--out') || join(appDir, 'dist'));
const runtimeSource = resolve(value('--runtime-source') || join(appDir, 'runtime', 'platforms', platform));
if (!RELEASE_PLATFORMS.has(platform)) throw new Error('Pass --platform with one supported runtime target');
if (process.env.CAPSULE_DEV_MODE === '1') throw new Error('Official release artifacts cannot be built in developer mode');
const keyFile = process.env.CAPSULE_SIGNING_KEY || join(homedir(), '.capsule-signing', 'key.pem');
const publicPem = readFileSync(join(appDir, 'capsule-signing-pub.pem'), 'utf8');
const report = portableIntegrityReport(appDir, join(appDir, 'capsule-integrity.json'));
if (!report.verified || !report.signed) throw new Error('Refusing to package an unverified release');
const manifest = JSON.parse(readFileSync(join(appDir, 'capsule-integrity.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid package version');
const files = releaseFiles(appDir, manifest, platform, runtimeSource);
const runtimeRows = readFileSync(join(appDir, 'runtime', 'downloads.txt'), 'utf8').split('\n').filter((row) => row.startsWith(platform + '\t'));
for (const kind of ['node', 'ollama']) {
  const row = runtimeRows.find((line) => line.split('\t')[1] === kind)?.split('\t');
  if (!row || !/^[a-f0-9]{64}$/.test(row[4])) throw new Error(`Missing pinned ${platform} ${kind} binary hash`);
  const binary = join(runtimeSource, kind,
    kind === 'node' ? (platform.startsWith('win32') ? 'node.exe' : 'bin/node') : (platform.startsWith('win32') ? 'ollama.exe' : 'ollama'));
  const actual = sha256(readFileSync(binary));
  if (actual !== row[4]) throw new Error(`Bundled ${kind} executable does not match its pinned hash`);
}

mkdirSync(outDir, { recursive: true });
const stage = mkdtempSync(join(outDir, '.capsule-release-'));
const archiveName = `Capsule-v${version}-${platform}.zip`;
try {
  const root = join(stage, 'Capsule');
  const fixedTime = new Date('2000-01-01T00:00:00Z');
  for (const path of files) {
    if (path === 'capsule-integrity.json') continue;
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    const source = path.startsWith(`runtime/platforms/${platform}/`)
      ? join(runtimeSource, path.slice(`runtime/platforms/${platform}/`.length)) : join(appDir, path);
    copyFileSync(source, target);
    chmodSync(target, statSync(source).mode & 0o111 ? 0o755 : 0o644);
    utimesSync(target, fixedTime, fixedTime);
  }
  // Build and sign the exact allowlisted platform tree, including its profile.
  // Do not filter an existing signature or ship embedded copies of excluded files.
  const packagedManifest = buildReleaseManifest(root, { platform });
  packagedManifest.generated_at = manifest.generated_at;
  packagedManifest.signature = {
    algorithm: 'ed25519', pubkey_sha256: pubkeyFingerprint(publicPem),
    value: sign(null, Buffer.from(canonicalManifest(packagedManifest)), createPrivateKey(readFileSync(keyFile))).toString('base64'),
  };
  const stagedManifest = join(root, 'capsule-integrity.json');
  writeFileSync(stagedManifest, JSON.stringify(packagedManifest, null, 2) + '\n');
  utimesSync(stagedManifest, fixedTime, fixedTime);
  if (!portableIntegrityReport(root, stagedManifest).verified) throw new Error('Packaged manifest verification failed');
  const fixDirs = (dir) => { for (const item of readdirSync(dir, { withFileTypes: true })) if (item.isDirectory()) fixDirs(join(dir, item.name)); utimesSync(dir, fixedTime, fixedTime); };
  fixDirs(root);
  const stagedArchive = join(stage, archiveName);
  const run = spawnSync('zip', ['-X', '-q', '-r', stagedArchive, 'Capsule'], { cwd: stage, encoding: 'utf8' });
  if (run.status !== 0) throw new Error('zip failed: ' + (run.stderr || run.error?.message || run.status));
  const checksum = checksumLine(archiveName, readFileSync(stagedArchive));
  const signature = signChecksums(checksum, readFileSync(keyFile, 'utf8'), publicPem);
  renameSync(stagedArchive, join(outDir, archiveName));
  writeFileSync(join(outDir, archiveName + '.sha256'), checksum);
  writeFileSync(join(outDir, archiveName + '.sha256.sig'), signature);
  writeFileSync(join(outDir, archiveName + '.release.json'), JSON.stringify({ version, platform, archive: archiveName, archive_sha256: checksum.slice(0, 64), public_key_sha256: pubkeyFingerprint(publicPem), manifest_schema: packagedManifest.schema_version, signed_files: packagedManifest.files.length }, null, 2) + '\n');
  console.log(`Built ${join(outDir, archiveName)} (${files.length} files)`);
  console.log(`Public release key fingerprint: ${pubkeyFingerprint(publicPem)}`);
} finally { rmSync(stage, { recursive: true, force: true }); }
