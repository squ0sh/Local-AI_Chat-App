import { createHash, createPrivateKey, sign, verify, createPublicKey } from 'crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { distributionPaths, assertDistributionContents, RELEASE_PLATFORMS } from './release-layout.mjs';

export { RELEASE_PLATFORMS };

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function safeReleasePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/')
    && !path.includes('\\') && !path.split('/').some((part) => !part || part === '.' || part === '..')
    && !/(?:^|\/)(?:\.git|\.portable|node_modules|\.env(?:\..*)?|data|logs)(?:\/|$)/i.test(path)
    && !/(?:^|\/)(?:key\.pem|id_ed25519|id_rsa|\.DS_Store)(?:$|\/)/i.test(path);
}

export function releaseFiles(appDir, manifest, platform, runtimeSource = join(appDir, 'runtime', 'platforms', platform)) {
  if (!RELEASE_PLATFORMS.has(platform)) throw new Error('Unsupported release platform');
  const sourcePaths = (manifest?.files || []).map((entry) => entry.path);
  if (!sourcePaths.length || sourcePaths.some((path) => !safeReleasePath(path))) throw new Error('Manifest contains an unsafe release path');
  const files = distributionPaths(platform);
  for (const path of files) if (!sourcePaths.includes(path)) throw new Error('Required distribution file is not signed: ' + path);
  files.push('capsule-integrity.json');
  const runtimeRoot = resolve(runtimeSource);
  if (!existsSync(runtimeRoot)) throw new Error(`Bundled ${platform} runtime is missing. Run the pinned runtime packaging step first.`);
  if (lstatSync(runtimeRoot).isSymbolicLink()) throw new Error('Unsafe runtime root: symbolic link');
  const visit = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      const rel = `runtime/platforms/${platform}/` + relative(runtimeRoot, full).split(sep).join('/');
      if (!safeReleasePath(rel) || item.isSymbolicLink() || /\.(?:pem|key|p12|pfx)$/i.test(rel) || /(?:^|\/)(?:credential|secret|token)[^/]*(?:\/|$)/i.test(rel)) throw new Error(`Unsafe runtime entry: ${rel}`);
      if (item.isDirectory()) visit(full);
      else if (item.isFile()) files.push(rel);
      else throw new Error(`Unsupported runtime entry: ${rel}`);
    }
  };
  visit(runtimeRoot);
  for (const path of files) {
    const full = path.startsWith(`runtime/platforms/${platform}/`)
      ? resolve(runtimeRoot, path.slice(`runtime/platforms/${platform}/`.length)) : resolve(appDir, path);
    if (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) throw new Error(`Missing or unsafe release file: ${path}`);
    const base = path.startsWith(`runtime/platforms/${platform}/`) ? runtimeRoot : resolve(appDir);
    if (realpathSync(full) !== join(realpathSync(base), relative(base, full))) throw new Error('Symbolic link in release path: ' + path);
    if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\r\n A-Za-z0-9+/=]{30,8192}-----END (?:[A-Z ]*PRIVATE KEY)-----/.test(readFileSync(full).toString('latin1'))) throw new Error('Private signing material in release file: ' + path);
  }
  assertDistributionContents(files, platform);
  return [...new Set(files)].sort();
}

export function checksumLine(name, bytes) {
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(name)) throw new Error('Invalid archive name');
  return `${sha256(bytes)}  ${name}\n`;
}

export function signChecksums(checksums, privatePem, publicPem) {
  const key = createPrivateKey(privatePem);
  const signature = sign(null, Buffer.from(checksums), key);
  if (!verify(null, Buffer.from(checksums), createPublicKey(publicPem), signature)) throw new Error('Release key does not match the pinned public key');
  return signature.toString('base64') + '\n';
}

export function verifyChecksums(checksums, signatureText, publicPem) {
  return verify(null, Buffer.from(checksums), createPublicKey(publicPem), Buffer.from(signatureText.trim(), 'base64'));
}
