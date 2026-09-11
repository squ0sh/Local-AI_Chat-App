import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
// Memory-hard KDF cost for offline vaults. N=2^15 with a fresh salt makes
// brute-forcing short passphrases substantially more expensive than Node's
// default N=2^14. r=8, p=1 stays compatible with OpenSSL scrypt.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
}

export function sealVault(plaintext, passphrase) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    version: 2,
    kdf: { name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function openVault(blob, passphrase) {
  const salt = Buffer.from(blob.salt, 'base64');
  // v1 blobs were derived with Node's default scrypt parameters (N=2^14).
  const key = blob.version === 2
    ? deriveKey(passphrase, salt)
    : scryptSync(passphrase, salt, KEY_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}
