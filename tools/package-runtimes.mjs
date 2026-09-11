import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(appDir, 'runtime');
const stageDir = join(runtimeDir, `.platforms-stage-${process.pid}`);
const workDir = mkdtempSync(join(tmpdir(), 'local-ai-runtimes-'));

const NODE_VERSION = '26.8.1';
const OLLAMA_VERSION = '0.33.3';

const nodeArtifacts = {
  'linux-x64': ['node-v26.8.1-linux-x64.tar.xz', '3e301118d7df53d563b7e96c1617545f26e2f76f9724be668d6cab65c15dda5d'],
  'linux-arm64': ['node-v26.8.1-linux-arm64.tar.xz', '23c1b4d19e2f12a7d06fe8aa3d6e0e4923cf77a47e13c5ccdf32fadaa33960f2'],
  'darwin-x64': ['node-v26.8.1-darwin-x64.tar.xz', '977c742754a1fa2425d3d9b4a17ca0ba4809919030432f47880b3dba8260cb6f'],
  'darwin-arm64': ['node-v26.8.1-darwin-arm64.tar.xz', 'b32047d86467497d3f59b8cf81f422c06938cf5f36ece2b36f6e7c024a0a3e5b'],
  'win32-x64': ['win-x64/node.exe', '5cba0ea928508c65ddadefc0681d2fb6d95f1f3beea4428f04397631140ee8e5'],
  'win32-arm64': ['win-arm64/node.exe', '8f359458741eaccce126ce45b1754e164b28849d05f7dfc2fdd1567054f47afc'],
};

const ollamaArtifacts = {
  'linux-x64': ['ollama-linux-amd64.tar.zst', 'c13cea8f3389db4145f8a6cb88d1747242a48639d7c13e3bda7c1ebdc6eebb2f'],
  'linux-arm64': ['ollama-linux-arm64.tar.zst', '4425a112af999ae6572c1ce211fbabeaca7bab23ed5860972acdfc0cc2358420'],
  'win32-x64': ['ollama-windows-amd64.zip', '52cb36a62e7e501f61514f60212dec7117b6c098811357585e02fffe32d2fcd7'],
  'win32-arm64': ['ollama-windows-arm64.zip', '98b9ddaab6baece0418c6d1231526eb1e4e66944985e0a8eeb7d6171bcd7b6d8'],
  darwin: ['ollama-darwin.tgz', '342db03df80bb9db84ff64246031bd5f70c09b59ff52fa5cc9aaae3476cc4a9d'],
};

function hashFile(path) {
  return execFileSync('sha256sum', [path], { encoding: 'utf8' }).split(/\s+/)[0];
}

function download(url, expected) {
  const destination = join(workDir, basename(url));
  console.log(`Downloading ${basename(url)}…`);
  execFileSync('curl', ['--fail', '--location', '--retry', '3', '--progress-bar', '--output', destination, url], { stdio: 'inherit' });
  const actual = hashFile(destination);
  if (actual !== expected) throw new Error(`Checksum mismatch for ${basename(url)}: ${actual}`);
  return destination;
}

function findNamed(root, name) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findNamed(path, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) return path;
  }
  return '';
}

function extract(archive) {
  const destination = join(workDir, `extract-${basename(archive).replace(/[^a-z0-9]/gi, '-')}`);
  mkdirSync(destination, { recursive: true });
  const excluded = ['*cuda*', '*cublas*', '*cudnn*', '*rocm*', '*hip*', '*mlx*', '*jetpack*'];
  if (archive.endsWith('.zip')) execFileSync('unzip', ['-q', archive, '-d', destination, '-x', ...excluded], { stdio: 'inherit' });
  else if (archive.endsWith('.tar.zst')) execFileSync('tar', ['--zstd', ...excluded.map((pattern) => `--exclude=${pattern}`), '-xf', archive, '-C', destination], { stdio: 'inherit' });
  else execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit' });
  return destination;
}

function copyTreeWithoutLinks(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) copyTreeWithoutLinks(sourcePath, destinationPath);
    else if (entry.isSymbolicLink()) {
      const resolved = realpathSync(sourcePath);
      if (statSync(resolved).isDirectory()) copyTreeWithoutLinks(resolved, destinationPath);
      else {
        copyFileSync(resolved, destinationPath);
        chmodSync(destinationPath, statSync(resolved).mode);
      }
    } else {
      copyFileSync(sourcePath, destinationPath);
      chmodSync(destinationPath, statSync(sourcePath).mode);
    }
  }
}

function pruneAcceleration(root) {
  if (!existsSync(root)) return;
  const accelerator = /^(cuda|cublas|cudnn|rocm|hip|mlx|jetpack)/i;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (accelerator.test(entry.name)) rmSync(path, { recursive: true, force: true });
    else if (entry.isDirectory()) pruneAcceleration(path);
  }
}

function flattenLinks(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) flattenLinks(path);
    else if (entry.isSymbolicLink()) {
      const resolved = realpathSync(path);
      const replacement = path + '.portable-file';
      if (statSync(resolved).isDirectory()) {
        unlinkSync(path);
        copyTreeWithoutLinks(resolved, path);
      } else {
        copyFileSync(resolved, replacement);
        chmodSync(replacement, lstatSync(resolved).mode);
        unlinkSync(path);
        renameSync(replacement, path);
      }
    }
  }
}

function platformRoot(id) {
  const root = join(stageDir, id);
  mkdirSync(root, { recursive: true });
  return root;
}

function packageNode(id, artifact, checksum) {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}/`;
  const archive = download(base + artifact, checksum);
  const root = platformRoot(id);
  if (id.startsWith('win32-')) {
    mkdirSync(join(root, 'node'), { recursive: true });
    copyFileSync(archive, join(root, 'node', 'node.exe'));
    rmSync(archive, { force: true });
    return;
  }
  const extracted = join(workDir, `node-${id}`);
  mkdirSync(extracted, { recursive: true });
  execFileSync('tar', ['-xJf', archive, '-C', extracted], { stdio: 'inherit' });
  const binary = findNamed(extracted, 'node');
  if (!binary) throw new Error(`Node executable not found for ${id}`);
  mkdirSync(join(root, 'node', 'bin'), { recursive: true });
  copyFileSync(binary, join(root, 'node', 'bin', 'node'));
  chmodSync(join(root, 'node', 'bin', 'node'), 0o755);
  rmSync(archive, { force: true });
  rmSync(extracted, { recursive: true, force: true });
}

function packageOllama(id, artifact, checksum) {
  const base = `https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/`;
  const archive = download(base + artifact, checksum);
  const extracted = extract(archive);
  const root = join(platformRoot(id), 'ollama');
  mkdirSync(root, { recursive: true });
  const executableName = id.startsWith('win32-') ? 'ollama.exe' : 'ollama';
  const executable = findNamed(extracted, executableName);
  if (!executable) throw new Error(`Ollama executable not found for ${id}`);
  copyFileSync(executable, join(root, executableName));
  if (!id.startsWith('win32-')) chmodSync(join(root, executableName), 0o755);
  const libraryRoot = findNamed(extracted, 'llama-server');
  if (libraryRoot) copyTreeWithoutLinks(dirname(libraryRoot), join(root, 'lib', 'ollama'));
  else {
    const topLib = join(extracted, 'lib');
    if (existsSync(topLib)) copyTreeWithoutLinks(topLib, join(root, 'lib'));
    for (const entry of readdirSync(extracted)) {
      if (entry.toLowerCase() !== executableName.toLowerCase()) {
        const source = join(extracted, entry);
        if (statSync(source).isDirectory()) copyTreeWithoutLinks(source, join(root, entry));
        else copyFileSync(source, join(root, entry));
      }
    }
  }
  pruneAcceleration(root);
  rmSync(archive, { force: true });
  rmSync(extracted, { recursive: true, force: true });
}

function packageDarwinOllama() {
  const [artifact, checksum] = ollamaArtifacts.darwin;
  const archive = download(`https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/${artifact}`, checksum);
  const extracted = extract(archive);
  const executable = findNamed(extracted, 'ollama');
  if (!executable) throw new Error('Ollama executable not found for macOS');
  for (const id of ['darwin-x64', 'darwin-arm64']) {
    const destination = join(platformRoot(id), 'ollama', 'ollama');
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(executable, destination);
    chmodSync(destination, 0o755);
  }
  rmSync(archive, { force: true });
  rmSync(extracted, { recursive: true, force: true });
}

try {
  mkdirSync(stageDir, { recursive: true });
  for (const [id, [artifact, checksum]] of Object.entries(nodeArtifacts)) packageNode(id, artifact, checksum);
  for (const [id, [artifact, checksum]] of Object.entries(ollamaArtifacts)) {
    if (id !== 'darwin') packageOllama(id, artifact, checksum);
  }
  packageDarwinOllama();
  flattenLinks(stageDir);

  const platforms = Object.keys(nodeArtifacts).sort();
  const index = {
    schema_version: 2,
    node_version: NODE_VERSION,
    ollama_version: OLLAMA_VERSION,
    profile: 'portable-cpu-baseline',
    platforms,
    generated_at: new Date().toISOString(),
  };
  writeFileSync(join(runtimeDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

  const destination = join(runtimeDir, 'platforms');
  const backup = join(runtimeDir, `.platforms-backup-${process.pid}`);
  if (existsSync(destination)) renameSync(destination, backup);
  renameSync(stageDir, destination);
  rmSync(backup, { recursive: true, force: true });
  console.log(`Packaged ${platforms.length} runtime targets.`);
} finally {
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}
