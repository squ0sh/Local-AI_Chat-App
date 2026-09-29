import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { capsuleTrustFromEnv, repairReleaseFiles } from '../lib/capsule-integrity.mjs';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const trust = capsuleTrustFromEnv();
if (trust.legacyUnsignedIgnored) {
  console.error('CAPSULE_ALLOW_UNSIGNED is obsolete and was ignored. Use CAPSULE_DEV_MODE=1 only for an intentional developer copy.');
}
const result = repairReleaseFiles(appDir, join(appDir, 'capsule-integrity.json'), {
  policy: 'missing',
  allowUnsigned: trust.allowUnsigned,
});
if (!result.verified) {
  console.error('Capsule could not verify this installation. Some protected files may be changed or damaged.');
  console.error('For your safety, Capsule stopped. Download a fresh copy from the official GitHub Releases page.');
  console.error('Technical detail: ' + (result.signature_error || result.failed?.[0]?.error || 'release files do not match'));
  process.exit(78);
}
if (result.restored.length) console.log('Restored missing signed release files: ' + result.restored.join(', '));
console.log('Capsule release verified (' + result.files.length + ' files, ' + (trust.devMode ? 'developer mode' : 'signed release') + ').');
