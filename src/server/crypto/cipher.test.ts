import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCipher, DecryptionError } from './cipher.js';

describe('cipher', () => {
  const key = randomBytes(32);
  const cipher = createCipher(key);

  it('round-trips strings and json', () => {
    const blob = cipher.encrypt('Hi {{user}}, your withdrawal is on the way.', 'macro:1');
    expect(cipher.decrypt(blob, 'macro:1').toString('utf8')).toBe('Hi {{user}}, your withdrawal is on the way.');
    const j = cipher.encryptJson({ a: 1, b: ['x'] }, 'settings:app');
    expect(cipher.decryptJson(j, 'settings:app')).toEqual({ a: 1, b: ['x'] });
  });

  it('does not leak plaintext and uses random nonces', () => {
    const a = cipher.encrypt('secret macro text', 'x');
    const b = cipher.encrypt('secret macro text', 'x');
    expect(a.equals(b)).toBe(false);
    expect(a.toString('latin1')).not.toContain('secret');
  });

  it('rejects wrong AAD, wrong key and tampering', () => {
    const blob = cipher.encrypt('hello', 'row:1');
    expect(() => cipher.decrypt(blob, 'row:2')).toThrow(DecryptionError);
    expect(() => createCipher(randomBytes(32)).decrypt(blob, 'row:1')).toThrow(DecryptionError);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt(tampered, 'row:1')).toThrow(DecryptionError);
  });

  it('produces stable keyed hmacs', () => {
    expect(cipher.hmac('abc')).toBe(cipher.hmac('abc'));
    expect(cipher.hmac('abc')).not.toBe(createCipher(randomBytes(32)).hmac('abc'));
  });
});
