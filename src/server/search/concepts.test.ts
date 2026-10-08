import { describe, expect, it } from 'vitest';
import { CONCEPTS, findConcepts } from '../domain/igaming.js';
import { correctTypo, matchConcepts } from './concepts.js';
import { conceptIdsOf } from './signals.js';

const SAMPLES = [
  'my btc cashout is stuck',
  "Hi, I deposited 200 USDT (TRC-20) 3 hours ago and it hasn't arrived. Where's my money?",
  'I want to self-exclude. Please block me, I think I am addicted.',
  "can't log in, lost my phone with google authenticator / 2FA",
  'Bet ID 12345: my parlay was voided?! Cash-out not available, over/under market resettled',
  'VIP rank Platinum IV -> Diamond: when is my weekly bonus & monthly bonus, rakeback?',
  'The game froze (black screen) while playing Plinko; server seed + client seed?',
  'WITHDRAWAL PENDING!!! how long?? tx hash: 0xabc',
  'withdrawals,deposits;bonuses.kyc-level 2 proof of address',
  'nothing relevant here at all',
  '',
];

describe('matchConcepts', () => {
  it('returns exactly what findConcepts returns (keys, terms and order)', () => {
    for (const text of SAMPLES) expect([...matchConcepts(text)], text).toEqual([...findConcepts(text)]);
  });

  it('matches every concept term on its own and inside a sentence like findConcepts', () => {
    for (const group of CONCEPTS) {
      for (const term of group.terms) {
        for (const text of [term, `so ${term}, ok`, `x${term}`, `${term}x`]) {
          expect([...matchConcepts(text)], text).toEqual([...findConcepts(text)]);
        }
      }
    }
  });

  it('respects word boundaries', () => {
    expect(matchConcepts('deposition').has('deposit')).toBe(false);
    expect(matchConcepts('my deposit.').get('deposit')).toEqual(['deposit']);
  });
});

describe('correctTypo', () => {
  it('fixes common misspellings of domain words', () => {
    expect(correctTypo('withdrawl')).toBe('withdrawal');
    expect(correctTypo('withdrawel')).toBe('withdrawal');
    expect(correctTypo('withdarwal')).toBe('withdrawal');
    expect(correctTypo('pendng')).toBe('pending');
    expect(correctTypo('depost')).toBe('deposit');
    expect(correctTypo('verfy')).toBe('verify');
    expect(correctTypo('bouns')).toBe('bonus');
    expect(correctTypo('pasword')).toBe('password');
    expect(correctTypo('rakebak')).toBe('rakeback');
  });

  it('leaves real words, exact terms and short tokens alone', () => {
    for (const w of ['withdrawal', 'spending', 'leading', 'reading', 'layer', 'spots', 'total', 'broke', 'money', 'game', 'bet', 'trc20']) {
      expect(correctTypo(w), w).toBeNull();
    }
  });

  it('still corrects the longest terms (one letter too many or too few)', () => {
    expect(correctTypo('cryptocurrencyy')).toBe('cryptocurrency');
    expect(correctTypo('cryptocurency')).toBe('cryptocurrency');
  });

  it('skips very long letter-only tokens in constant time (no quadratic work)', () => {
    // Fresh tokens each run: the result is memoized per token.
    const stamp = String.fromCharCode(97 + (Date.now() % 26));
    const mash = `${stamp}${'a'.repeat(4999)}`;
    const words = `${stamp}${'withdrawalpendingdepositbonus'.repeat(200)}`;
    const started = performance.now();
    expect(correctTypo(mash)).toBeNull();
    expect(correctTypo(words)).toBeNull();
    expect(conceptIdsOf(`hi ${'q'.repeat(8000)} where is my withdrawl`).has('withdrawal')).toBe(true);
    expect(performance.now() - started).toBeLessThan(20);
  });

  it('keeps a message full of distinct long-ish tokens cheap', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const tokens = Array.from({ length: 500 }, (_, i) => `z${letters[i % 26]}${letters[Math.floor(i / 26) % 26]}${'q'.repeat(12)}`);
    const started = performance.now();
    conceptIdsOf(tokens.join(' '));
    expect(performance.now() - started).toBeLessThan(50);
  });
});
