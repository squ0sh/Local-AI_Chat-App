import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Verifies a release manifest without accepting paths outside the app folder.
 * Hashes identify accidental edits or incomplete copies; they are not a
 * substitute for a signed release downloaded from a trusted source.
 */
export function portableIntegrityReport(appDir, manifestFile, options = {}) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); }
  catch (error) { return { verified: false, error: 'Integrity manifest is unavailable: ' + error.message, files: [] }; }

  const allEntries = Array.isArray(manifest.files) ? manifest.files : [];
  const entries = options.platform
    ? allEntries.filter((entry) => !String(entry.path || '').startsWith('runtime/platforms/') || String(entry.path || '').startsWith(`runtime/platforms/${options.platform}/`))
    : allEntries;
  const files = entries.map((entry) => {
    const path = String(entry.path || '');
    if (!path || path.includes('..') || path.startsWith('/') || path.includes('\\')) {
      return { path, ok: false, error: 'Invalid manifest path' };
    }
    try {
      const file = join(appDir, path);
      const bytes = statSync(file).size;
      const actual = sha256File(file);
      return { path, ok: actual === entry.sha256 && bytes === entry.bytes, bytes, expected_bytes: entry.bytes, actual, expected: entry.sha256 };
    } catch (error) { return { path, ok: false, error: error.message }; }
  });

  return { verified: files.length > 0 && files.every((file) => file.ok), generated_at: manifest.generated_at || '', files };
}
