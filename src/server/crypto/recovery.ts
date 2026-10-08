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

export function generateRecoveryKey(): string {
  throw new Error('TODO');
}

/** Canonical form used for key derivation; throws on invalid length/characters. */
export function normalizeRecoveryKey(input: string): string {
  throw new Error('TODO');
}

export function wrapMasterKey(masterKey: Buffer, recoveryKey: string): WrappedKey {
  throw new Error('TODO');
}

/** Throws Error('Invalid recovery key') when the key is wrong. */
export function unwrapMasterKey(wrapped: WrappedKey, recoveryKey: string): Buffer {
  throw new Error('TODO');
}
