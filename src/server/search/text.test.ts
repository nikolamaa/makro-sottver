import { describe, expect, it } from 'vitest';
import { indexTermForms, isNoiseToken, stem, stripTemplateVariables, tokenize } from './text.js';

describe('tokenize', () => {
  it('lowercases, splits on punctuation and drops apostrophes inside words', () => {
    expect(tokenize("Can't withdraw my BTC! player's tx_hash: 0xAB")).toEqual(['cant', 'withdraw', 'my', 'btc', 'players', 'tx', 'hash', '0xab']);
  });

  it('keeps non-latin letters and digits together', () => {
    expect(tokenize('2FA código trc20')).toEqual(['2fa', 'código', 'trc20']);
  });
});

describe('isNoiseToken', () => {
  it('drops stopwords, chat filler, numbers, 1-char tokens and hash-like strings', () => {
    for (const t of ['the', 'please', 'thanks', 'hi', 'since', 'x', '250', '0x3fa85f6457174562b3fc2c963f66afa6']) expect(isNoiseToken(t), t).toBe(true);
  });

  it('keeps domain words and short codes', () => {
    for (const t of ['withdrawal', 'kyc', '2fa', 'id', 'won', 'max', 'wd']) expect(isNoiseToken(t), t).toBe(false);
  });
});

describe('stem', () => {
  it('strips simple inflections consistently', () => {
    expect(stem('withdrawals')).toBe('withdrawal');
    expect(stem('pending')).toBe('pend');
    expect(stem('deposited')).toBe('deposit');
    expect(stem('deposits')).toBe('deposit');
    expect(stem('verified')).toBe('verify');
    expect(stem('verifies')).toBe('verify');
    expect(stem('bonuses')).toBe('bonus');
    expect(stem('weekly')).toBe('week');
    expect(stem('betting')).toBe('bet');
  });

  it('maps related forms to the same stem', () => {
    expect(new Set(['close', 'closed', 'closes', 'closing'].map(stem)).size).toBe(1);
  });

  it('leaves short words, words with digits and protected endings alone', () => {
    for (const w of ['bet', 'trc20', '2fa', 'bonus', 'access', 'apply', 'reply', 'need']) expect(stem(w), w).toBe(w);
  });
});

describe('index and query terms', () => {
  it('indexes the stem plus the surface form when they differ', () => {
    expect(indexTermForms('pending')).toEqual(['pend', 'pending']);
    expect(indexTermForms('btc')).toEqual(['btc']);
    expect(indexTermForms('the')).toBeNull();
  });

  it('removes template variables but keeps surrounding text', () => {
    expect(stripTemplateVariables('Hi {{user}}, your {{crypto|crypto}} withdrawal is pending.')).toBe('Hi , your  withdrawal is pending.');
  });
});
