// Read-only, redacted audit. Never logs matched bytes or private-key contents.
import { execFileSync, spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = resolve(process.argv[2] || '.');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 }).toString();
const findings = [];
const patterns = [
  ['private PEM block', /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\r\n A-Za-z0-9+/=]{30,8192}-----END (?:[A-Z ]*PRIVATE KEY)-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['API token', /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{35}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];
let identityCompared = false;
try {
  const key = createPrivateKey(readFileSync(process.env.CAPSULE_SIGNING_KEY || join(homedir(), '.capsule-signing/key.pem')));
  const pub = createPublicKey(readFileSync(join(root, 'capsule-signing-pub.pem'))).export({ type: 'spki', format: 'der' });
  if (!createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(pub)) throw new Error('Signing identity mismatch');
  const seed = Buffer.from(key.export({ format: 'jwk' }).d, 'base64url');
  for (const encoding of ['hex', 'base64', 'base64url']) patterns.push(['official signing seed (' + encoding + ')', seed.toString(encoding)]);
  patterns.push(['official signing seed (raw)', seed.toString('latin1')]);
  identityCompared = true;
} catch { /* Missing key is reported, not printed. Public-key-only audit still works. */ }

function inspect(bytes, location) {
  const text = bytes.toString('latin1');
  for (const [kind, pattern] of patterns) {
    if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) {
      if (!findings.some((f) => f.location === location && f.kind === kind)) findings.push({ location, kind });
    }
  }
}
async function scan(stream, location) {
  let tail = Buffer.alloc(0);
  for await (const chunk of stream) {
    const data = Buffer.concat([tail, chunk]);
    inspect(data, location);
    tail = data.subarray(Math.max(0, data.length - 16384));
  }
}
const objects = git('cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)').trim().split('\n');
let blobs = 0, embedded = 0, localFiles = 0;
for (const row of objects) {
  const [oid, type, size] = row.split(' ');
  if (type !== 'blob') continue;
  blobs++;
  const child = spawn('git', ['-C', root, 'cat-file', 'blob', oid], { stdio: ['ignore', 'pipe', 'ignore'] });
  const done = new Promise((res, rej) => { child.on('error', rej); child.on('close', (code) => code === 0 ? res() : rej(new Error('Git object read failed'))); });
  await scan(child.stdout, 'git blob ' + oid);
  await done;
  if (Number(size) < 50000000) {
    const raw = execFileSync('git', ['-C', root, 'cat-file', 'blob', oid], { maxBuffer: 50000000 });
    // Historical manifests can contain secrets in compressed repair payloads.
    if (raw.includes(Buffer.from('"schema_version"')) && raw.includes(Buffer.from('"files"'))) {
      try { for (const entry of JSON.parse(raw).files || []) if (entry.content) {
        const bytes = gunzipSync(Buffer.from(entry.content, 'base64'), { maxOutputLength: 50000000 });
        inspect(bytes, 'git blob ' + oid + ' embedded ' + entry.path); embedded++;
      } } catch { /* Not a JSON integrity manifest. Raw bytes were scanned. */ }
    }
  }
}
async function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (item.name === '.git') continue;
    const file = join(dir, item.name);
    if (item.isDirectory()) await walk(file);
    else if (item.isFile()) {
      localFiles++; await scan(createReadStream(file), 'file ' + file.slice(root.length + 1));
      if (/^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?|key\.pem)$/i.test(item.name)) findings.push({ location: file.slice(root.length + 1), kind: 'sensitive filename; inspect locally' });
    }
  }
}
await walk(root);
console.log(JSON.stringify({ shallow: git('rev-parse', '--is-shallow-repository').trim(), scope: 'all available Git objects including unreachable objects; embedded historical manifests; all local regular files (not symlinks or .git); no size cap on raw scanning', identityCompared, blobs, embedded, localFiles, findings }, null, 2));
process.exitCode = findings.length ? 1 : 0;
