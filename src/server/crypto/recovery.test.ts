import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  generateRecoveryKey,
  isWrappedKey,
  normalizeRecoveryKey,
  unwrapMasterKey,
  wrapMasterKey,
  type WrappedKey,
} from './recovery.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_FORMAT_RE = /^MPRK(-[0-9A-HJKMNP-TV-Z]{4}){8}$/;

/** Independent reference encoder (big-integer arithmetic) to cross-check the bit-stream implementation. */
function referenceBase32(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  for (let i = 0; i < (bytes.length * 8) / 5; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

function withFixedRandom(bytes: Buffer): string {
  vi.mocked(randomBytes).mockImplementationOnce((() => bytes) as unknown as typeof randomBytes);
  return generateRecoveryKey();
}

function stripFormatting(key: string): string {
  return key.replace(/^MPRK-/, '').replaceAll('-', '');
}

describe('generateRecoveryKey', () => {
  it('produces MPRK- plus 8 groups of 4 Crockford base32 characters', () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(KEY_FORMAT_RE);
    expect(key).toHaveLength(5 + 32 + 7);
  });

  it('is random every time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateRecoveryKey()));
    expect(keys.size).toBe(50);
  });

  it('encodes all 160 random bits (known vectors)', () => {
    expect(stripFormatting(withFixedRandom(Buffer.alloc(20, 0x00)))).toBe('0'.repeat(32));
    expect(stripFormatting(withFixedRandom(Buffer.alloc(20, 0xff)))).toBe('Z'.repeat(32));
    for (let i = 0; i < 20; i++) {
      const bytes = randomBytes(20);
      expect(stripFormatting(withFixedRandom(bytes))).toBe(referenceBase32(bytes));
    }
  });

  it('is already in canonical form', () => {
    const key = generateRecoveryKey();
    expect(normalizeRecoveryKey(key)).toBe(key);
  });
});

describe('normalizeRecoveryKey', () => {
  const key = 'MPRK-7Q2M-0A1B-C3D4-E5F6-G7H8-J9KM-NPQR-STVW';

  it.each([
    ['lowercase', key.toLowerCase()],
    ['missing prefix', key.slice(5)],
    ['missing prefix, lowercase, no dashes', key.slice(5).replaceAll('-', '').toLowerCase()],
    ['spaces instead of dashes', key.replaceAll('-', ' ')],
    ['surrounding whitespace and extra separators', `  ${key.replaceAll('-', ' - ')}\n`],
    ['prefix without dash', key.replace('MPRK-', 'MPRK')],
    ['en dashes (word-processor autocorrect)', key.replaceAll('-', '\u2013')],
    ['em dashes', key.replaceAll('-', '\u2014')],
    ['non-breaking hyphens', key.replaceAll('-', '\u2011')],
    ['minus signs', key.replaceAll('-', '\u2212')],
    ['non-breaking spaces', key.replaceAll('-', '\u00a0')],
    ['zero-width spaces and soft hyphens from a copied web page', key.replaceAll('-', '\u200b').replace('7Q2M', '7Q\u00ad2M')],
  ])('accepts %s', (_label, input) => {
    expect(normalizeRecoveryKey(input)).toBe(key);
  });

  it('applies the Crockford substitutions O->0, I->1, L->1', () => {
    expect(normalizeRecoveryKey('MPRK-7Q2M-OA1B-C3D4-E5F6-G7H8-J9KM-NPQR-STVW')).toBe(key);
    expect(normalizeRecoveryKey('mprk-7q2m-0aib-c3d4-e5f6-g7h8-j9km-npqr-stvw')).toBe(key);
    expect(normalizeRecoveryKey('MPRK-7Q2M-0ALB-C3D4-E5F6-G7H8-J9KM-NPQR-STVW')).toBe(key);
  });

  it.each([
    ['the letter U', key.replace('STVW', 'STUW')],
    ['an invalid character', key.replace('STVW', 'ST*W')],
    ['one character too few', key.slice(0, -1)],
    ['one character too many', `${key}X`],
    ['a wrong prefix', key.replace('MPRK', 'ABCD')],
    ['an empty string', ''],
    ['only separators', ' - - '],
    ['underscores as separators', key.replaceAll('-', '_')],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeRecoveryKey(input)).toThrow(new Error('Invalid recovery key format'));
  });
});

describe('wrapMasterKey / unwrapMasterKey', () => {
  const masterKey = randomBytes(32);
  const recoveryKey = generateRecoveryKey();
  let wrapped: WrappedKey;

  beforeAll(() => {
    wrapped = wrapMasterKey(masterKey, recoveryKey);
  });

  it('records the documented parameters and field sizes', () => {
    expect(wrapped).toMatchObject({ v: 1, kdf: 'scrypt', N: 2 ** 15, r: 8, p: 1 });
    expect(Buffer.from(wrapped.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(wrapped.nonce, 'base64')).toHaveLength(12);
    expect(Buffer.from(wrapped.ct, 'base64')).toHaveLength(32);
    expect(Buffer.from(wrapped.tag, 'base64')).toHaveLength(16);
    expect(isWrappedKey(wrapped)).toBe(true);
  });

  it('does not expose the master key', () => {
    expect(JSON.stringify(wrapped)).not.toContain(masterKey.toString('base64'));
    expect(Buffer.from(wrapped.ct, 'base64').equals(masterKey)).toBe(false);
  });

  it('round-trips, including with a sloppily typed recovery key', () => {
    expect(unwrapMasterKey(wrapped, recoveryKey).equals(masterKey)).toBe(true);
    const sloppy = stripFormatting(recoveryKey).toLowerCase().replaceAll('0', 'o').replaceAll('1', 'l');
    expect(unwrapMasterKey(wrapped, sloppy).equals(masterKey)).toBe(true);
  });

  it('survives JSON serialization (how it is stored in the database)', () => {
    const restored = JSON.parse(JSON.stringify(wrapped)) as WrappedKey;
    expect(unwrapMasterKey(restored, recoveryKey).equals(masterKey)).toBe(true);
  });

  it('uses a fresh salt and nonce for every wrap', () => {
    const again = wrapMasterKey(masterKey, recoveryKey);
    expect(again.salt).not.toBe(wrapped.salt);
    expect(again.nonce).not.toBe(wrapped.nonce);
    expect(again.ct).not.toBe(wrapped.ct);
  });

  it('rejects a wrong recovery key', () => {
    expect(() => unwrapMasterKey(wrapped, generateRecoveryKey())).toThrow(new Error('Invalid recovery key'));
  });

  it('rejects a tampered ciphertext or tag', () => {
    const ct = Buffer.from(wrapped.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 0x01;
    expect(() => unwrapMasterKey({ ...wrapped, ct: ct.toString('base64') }, recoveryKey)).toThrow(
      new Error('Invalid recovery key'),
    );
    const tag = Buffer.from(wrapped.tag, 'base64');
    tag[15] = (tag[15] ?? 0) ^ 0x80;
    expect(() => unwrapMasterKey({ ...wrapped, tag: tag.toString('base64') }, recoveryKey)).toThrow(
      new Error('Invalid recovery key'),
    );
  });

  it('rejects a malformed recovery key before deriving anything', () => {
    expect(() => unwrapMasterKey(wrapped, 'MPRK-UUUU')).toThrow(new Error('Invalid recovery key format'));
  });

  it('rejects master keys that are not 32 bytes', () => {
    expect(() => wrapMasterKey(randomBytes(16), recoveryKey)).toThrow('Master key must be 32 bytes');
  });

  it('rejects malformed recovery keys when wrapping', () => {
    expect(() => wrapMasterKey(masterKey, 'not a key')).toThrow(new Error('Invalid recovery key format'));
  });
});

describe('isWrappedKey', () => {
  const recoveryKey = generateRecoveryKey();
  let valid: WrappedKey;

  beforeAll(() => {
    valid = wrapMasterKey(randomBytes(32), recoveryKey);
  });

  it.each<[string, Record<string, unknown>]>([
    ['another version', { v: 2 }],
    ['another kdf', { kdf: 'pbkdf2' }],
    ['N not a power of two', { N: 30000 }],
    ['N too large (DoS)', { N: 2 ** 24 }],
    ['parameters needing more than 64 MiB', { N: 2 ** 16, r: 8 }],
    ['N not below 2^(16r), which OpenSSL refuses', { N: 2 ** 16, r: 1 }],
    ['N far above 2^(16r)', { N: 2 ** 18, r: 1, p: 1 }],
    ['too many parallel lanes', { p: 64 }],
    ['fractional r', { r: 8.5 }],
    ['short salt', { salt: randomBytes(8).toString('base64') }],
    ['non-base64 nonce', { nonce: '!!!!!!!!!!!!!!!!' }],
    ['missing tag', { tag: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(isWrappedKey({ ...valid, ...patch })).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'x', 1, []]) expect(isWrappedKey(value)).toBe(false);
  });

  it('unwrapMasterKey refuses structurally invalid input without running scrypt', () => {
    const hostile = { ...valid, N: 2 ** 30 } as WrappedKey;
    expect(() => unwrapMasterKey(hostile, recoveryKey)).toThrow(new Error('Invalid wrapped key'));
  });

  it('never surfaces a raw OpenSSL error for parameters it accepts or rejects', () => {
    // N=2^16, r=1 fits in memory but OpenSSL refuses it ("Invalid scrypt params ...").
    expect(() => unwrapMasterKey({ ...valid, N: 2 ** 16, r: 1 }, recoveryKey)).toThrow(new Error('Invalid wrapped key'));
    // The largest accepted N for r=1 really runs scrypt; the mismatch is then reported as a wrong key.
    const edge = { ...valid, N: 2 ** 15, r: 1, p: 4 };
    expect(isWrappedKey(edge)).toBe(true);
    expect(() => unwrapMasterKey(edge, recoveryKey)).toThrow(new Error('Invalid recovery key'));
  });
});
