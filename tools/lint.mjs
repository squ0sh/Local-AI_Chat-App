// Lightweight syntax linter: node --check every JS/ESM file plus each inline
// <script> block in HTML assets. Zero external dependencies by design.
import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const appDir = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const dirs = ['', 'lib', 'tools', 'test', 'cloud'];
const exts = ['.js', '.mjs', '.cjs'];
const htmlFiles = ['index.html', 'cloud/recover.html'].filter(f => {
  try { return statSync(join(appDir, f)).isFile(); } catch { return false; }
});

function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (exts.some(e => name.endsWith(e))) out.push(full);
  }
  return out;
}

function checkNode(file) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); return null; }
  catch (e) { return (e.stderr || e.message).toString().trim(); }
}

const files = new Set();
for (const d of dirs) walk(join(appDir, d)).forEach(f => files.add(f));

const errors = [];
for (const file of [...files].sort()) {
  const err = checkNode(file);
  if (err) errors.push({ file: file.slice(appDir.length + 1) || file, err });
}

for (const html of htmlFiles) {
  const src = readFileSync(join(appDir, html), 'utf8');
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(src))) {
    i += 1;
    const tmp = join(appDir, `.lint-inline-${html.replace(/[^a-z0-9]/gi, '-')}-${i}.js`);
    try {
      writeFileSync(tmp, m[1]);
      const err = checkNode(tmp);
      if (err) errors.push({ file: `${html} (inline script #${i})`, err });
    } finally { try { unlinkSync(tmp); } catch {} }
  }
}

if (errors.length) {
  console.error(`lint: ${errors.length} file(s) failed syntax check`);
  for (const e of errors) console.error(`\n  ✗ ${e.file}\n    ${e.err.replace(/\n/g, '\n    ')}`);
  process.exit(1);
}
console.log(`lint: OK — ${files.size} file(s) + html inline scripts passed node --check`);