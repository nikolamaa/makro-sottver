/**
 * Authenticated field-level encryption (AES-256-GCM) for everything MacroPilot stores.
 *
 * Blob layout: [0x01 version][12-byte random nonce][ciphertext][16-byte GCM tag]
 * The AAD (additional authenticated data) binds a ciphertext to its row, e.g. "macro_versions:<id>:<v>",
 * so an encrypted value copied into another row fails to decrypt instead of being silently accepted.
 *
 * Two subkeys are derived from the 256-bit master key with HKDF-SHA256:
 *   enc - AES-256-GCM key
 *   mac - HMAC-SHA256 key for deterministic content fingerprints (cache keys, change detection)
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export interface Cipher {
  encrypt(plaintext: string | Uint8Array, aad: string): Buffer;
  decrypt(blob: Uint8Array, aad: string): Buffer;
  encryptJson(value: unknown, aad: string): Buffer;
  decryptJson<T>(blob: Uint8Array, aad: string): T;
  /** Keyed fingerprint (hex). Reveals nothing about the content without the key. */
  hmac(data: string | Uint8Array): string;
}

const VERSION = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export class DecryptionError extends Error {
  constructor(message = 'Decryption failed (wrong key or corrupted data)') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function deriveSubkey(masterKey: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.from('macropilot/v1'), Buffer.from(info), 32));
}

export function createCipher(masterKey: Uint8Array): Cipher {
  if (masterKey.length !== 32) throw new Error('Master key must be 32 bytes');
  const encKey = deriveSubkey(masterKey, 'enc');
  const macKey = deriveSubkey(masterKey, 'mac');

  const encrypt = (plaintext: string | Uint8Array, aad: string): Buffer => {
    const nonce = randomBytes(NONCE_LEN);
    const c = createCipheriv('aes-256-gcm', encKey, nonce);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
    const ct = Buffer.concat([c.update(data), c.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, ct, c.getAuthTag()]);
  };

  const decrypt = (blob: Uint8Array, aad: string): Buffer => {
    const buf = Buffer.from(blob);
    if (buf.length < 1 + NONCE_LEN + TAG_LEN || buf[0] !== VERSION) throw new DecryptionError('Unsupported or corrupted ciphertext');
    const nonce = buf.subarray(1, 1 + NONCE_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ct = buf.subarray(1 + NONCE_LEN, buf.length - TAG_LEN);
    try {
      const d = createDecipheriv('aes-256-gcm', encKey, nonce);
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    } catch {
      throw new DecryptionError();
    }
  };

  return {
    encrypt,
    decrypt,
    encryptJson: (value, aad) => encrypt(JSON.stringify(value), aad),
    decryptJson: <T>(blob: Uint8Array, aad: string) => JSON.parse(decrypt(blob, aad).toString('utf8')) as T,
    hmac: (data) => createHmac('sha256', macKey).update(data).digest('hex'),
  };
}
