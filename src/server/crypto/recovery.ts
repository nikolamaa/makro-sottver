/**
 * Recovery key: a human-writable secret shown to the user once (first run). It wraps the master key so that
 * (a) an encrypted backup can be restored on another computer and (b) the data can be recovered if the OS
 * keychain entry is lost. Format: "MPRK-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" (Crockford base32 of 20
 * random bytes = 160 bits, 8 groups of 4 chars). Input is normalized: case-insensitive, spaces/dashes ignored,
 * and Crockford substitutions (O->0, I/L->1) applied.
 *
 * Wrapping: KEK = scrypt(normalizedRecoveryKey, salt(16 bytes), N=2^15, r=8, p=1, keylen=32, maxmem 64MB);
 *           masterKey encrypted with AES-256-GCM(KEK, nonce 12 bytes, AAD "macropilot-recovery-v1").
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export interface WrappedKey {
  v: 1;
  kdf: 'scrypt';
  /** base64 */
  salt: string;
  N: number;
  r: number;
  p: number;
  /** base64 */
  nonce: string;
  /** base64 */
  ct: string;
  /** base64 */
  tag: string;
}

const PREFIX = 'MPRK';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_BYTES = 20;
const KEY_CHARS = 32; // 20 bytes * 8 bits / 5 bits per char
const GROUP_SIZE = 4;

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/** Upper bounds for parameters read from a file, so a crafted backup cannot make unwrapping hang. */
const MAX_SCRYPT_N = 2 ** 20;
const MAX_SCRYPT_R = 32;
const MAX_SCRYPT_P = 4;

const MASTER_KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const AAD = Buffer.from('macropilot-recovery-v1', 'utf8');

const SEPARATORS_RE = /[\s-]+/g;
const CROCKFORD_SUBSTITUTIONS_RE = /[OIL]/g;
const CROCKFORD_SUBSTITUTIONS: Readonly<Record<string, string>> = { O: '0', I: '1', L: '1' };
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const VALID_CHARS_RE = new RegExp(`^[${ALPHABET}]{${KEY_CHARS}}$`);
const GROUP_RE = new RegExp(`.{${GROUP_SIZE}}`, 'g');

/** Crockford base32 without padding (input length must be a multiple of 5 bytes for an exact encoding). */
function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff; // never holds more than 12 meaningful bits
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** "MPRK-" + the 32 base32 characters in groups of 4. */
function formatRecoveryKey(chars: string): string {
  return [PREFIX, ...(chars.match(GROUP_RE) ?? [])].join('-');
}

/** A fresh random recovery key, e.g. "MPRK-7Q2M-…" (160 bits of entropy). Already in canonical form. */
export function generateRecoveryKey(): string {
  return formatRecoveryKey(encodeBase32(randomBytes(KEY_BYTES)));
}

/**
 * Canonical form used for key derivation; throws on invalid length/characters.
 * Accepts the key with or without the "MPRK" prefix, in any case, with any spaces or dashes, and applies the
 * Crockford substitutions O->0, I/L->1. Returns the display form "MPRK-XXXX-…-XXXX", which is exactly what
 * generateRecoveryKey() produces, so normalizeRecoveryKey(generateRecoveryKey()) is the identity.
 * Throws Error('Invalid recovery key format') for anything else (including the letter U).
 */
export function normalizeRecoveryKey(input: string): string {
  let chars = input.toUpperCase().replace(SEPARATORS_RE, '');
  if (chars.length === PREFIX.length + KEY_CHARS && chars.startsWith(PREFIX)) chars = chars.slice(PREFIX.length);
  chars = chars.replace(CROCKFORD_SUBSTITUTIONS_RE, (c) => CROCKFORD_SUBSTITUTIONS[c] ?? c);
  if (!VALID_CHARS_RE.test(chars)) throw new Error('Invalid recovery key format');
  return formatRecoveryKey(chars);
}

function deriveKek(normalizedKey: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(normalizedKey, salt, MASTER_KEY_LEN, { N, r, p, maxmem: SCRYPT_MAXMEM });
}

/** Wrap (encrypt) the 32-byte master key with a key derived from the recovery key. */
export function wrapMasterKey(masterKey: Buffer, recoveryKey: string): WrappedKey {
  if (masterKey.length !== MASTER_KEY_LEN) throw new Error('Master key must be 32 bytes');
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const kek = deriveKek(normalizeRecoveryKey(recoveryKey), salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  return {
    v: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isPowerOfTwo(n: number): boolean {
  return (n & (n - 1)) === 0;
}

/** Bytes OpenSSL allocates for scrypt(N, r, p); parameters above SCRYPT_MAXMEM are rejected by node:crypto. */
function scryptMemory(N: number, r: number, p: number): number {
  return 128 * r * (N + p + 2);
}

function isBase64OfLength(value: unknown, byteLength: number): value is string {
  return typeof value === 'string' && BASE64_RE.test(value) && Buffer.from(value, 'base64').length === byteLength;
}

/**
 * Structural check for a WrappedKey read from untrusted input (e.g. a backup file): right version, field
 * lengths, and scrypt parameters within safe bounds (N a power of two, memory within the scrypt limit and a
 * bounded cost, so a crafted file can neither cause a DoS nor an obscure crypto error).
 */
export function isWrappedKey(value: unknown): value is WrappedKey {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    w.v === 1 &&
    w.kdf === 'scrypt' &&
    isIntInRange(w.N, 2, MAX_SCRYPT_N) &&
    isPowerOfTwo(w.N) &&
    isIntInRange(w.r, 1, MAX_SCRYPT_R) &&
    isIntInRange(w.p, 1, MAX_SCRYPT_P) &&
    scryptMemory(w.N, w.r, w.p) <= SCRYPT_MAXMEM &&
    isBase64OfLength(w.salt, SALT_LEN) &&
    isBase64OfLength(w.nonce, NONCE_LEN) &&
    isBase64OfLength(w.ct, MASTER_KEY_LEN) &&
    isBase64OfLength(w.tag, TAG_LEN)
  );
}

/**
 * Unwrap the master key. Throws Error('Invalid recovery key') when the key is wrong (or the wrapped key was
 * tampered with - AES-GCM cannot tell the two apart), Error('Invalid recovery key format') for malformed
 * input and Error('Invalid wrapped key') when `wrapped` is structurally invalid.
 */
export function unwrapMasterKey(wrapped: WrappedKey, recoveryKey: string): Buffer {
  if (!isWrappedKey(wrapped)) throw new Error('Invalid wrapped key');
  const normalized = normalizeRecoveryKey(recoveryKey);
  const kek = deriveKek(normalized, Buffer.from(wrapped.salt, 'base64'), wrapped.N, wrapped.r, wrapped.p);
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(wrapped.nonce, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(wrapped.ct, 'base64')), decipher.final()]);
  } catch {
    throw new Error('Invalid recovery key');
  }
}
