import { describe, expect, it } from 'vitest';
import { buildReason, displayTerm, type ReasonInput } from './explain.js';

const base: ReasonInput = {
  coversIntents: [],
  relatedIntent: null,
  matchedTerms: [],
  breakdown: { semantic: 0, lexical: 0, intent: 0, usage: 0 },
  verification: 'unverified',
  hasFacts: false,
};

describe('buildReason', () => {
  it('explains an intent match with terms and verification', () => {
    expect(buildReason({ ...base, coversIntents: ['withdrawal_pending'], matchedTerms: ['pending', 'BTC', 'withdrawal', 'stuck'], verification: 'verified' })).toBe(
      'Matches the pending withdrawal question (pending, BTC, withdrawal) and the macro is verified.',
    );
  });

  it('keeps acronyms in intent labels and joins several intents', () => {
    expect(buildReason({ ...base, coversIntents: ['vip_program', 'bonus_inquiry', 'kyc_verification'] })).toBe(
      'Covers the VIP program, bonus inquiry and verification (KYC) questions.',
    );
  });

  it('falls back to related intents, shared terms, meaning or a weak-match sentence', () => {
    expect(buildReason({ ...base, relatedIntent: 'deposit_missing' })).toBe('Related to the missing deposit question.');
    expect(buildReason({ ...base, breakdown: { ...base.breakdown, lexical: 0.8 }, matchedTerms: ['cashout'] })).toBe(
      'Shares key terms with the message (cashout).',
    );
    expect(buildReason({ ...base, breakdown: { ...base.breakdown, semantic: 0.7 } })).toBe('Similar in meaning to the message.');
    expect(buildReason(base)).toBe('Closest available macro, but only loosely related.');
  });

  it('warns about unverified, outdated and conflicting facts', () => {
    expect(buildReason({ ...base, hasFacts: true })).toMatch(/; its facts are not verified yet\.$/);
    expect(buildReason({ ...base, verification: 'outdated' })).toMatch(/, but some of its facts are outdated\.$/);
    expect(buildReason({ ...base, verification: 'conflict' })).toMatch(/, but one of its facts conflicts with the source\.$/);
  });

  it('never exceeds 160 characters', () => {
    const long = 'x'.repeat(70);
    const reason = buildReason({
      ...base,
      coversIntents: ['withdrawal_pending', 'responsible_gambling', 'kyc_verification'],
      matchedTerms: [long, long, long],
      verification: 'conflict',
    });
    expect(reason.length).toBeLessThanOrEqual(160);
    expect(reason).toBe('Covers the pending withdrawal, responsible gambling and verification (KYC) questions, but one of its facts conflicts with the source.');
  });
});

describe('buildReason caveats', () => {
  const matched: ReasonInput = { ...base, coversIntents: ['betting_limits'], matchedTerms: ['max', 'bet', 'limit', 'tennis'], verification: 'verified' };

  it('names a product mismatch instead of praising the macro', () => {
    expect(buildReason({ ...matched, caveat: { kind: 'product', asked: ['sports'], macro: ['casino'] } })).toBe(
      'Matches the betting limits question (max, bet, limit), but it is about casino, not sports.',
    );
  });

  it('keeps fact warnings after a caveat', () => {
    expect(buildReason({ ...matched, caveat: { kind: 'product', asked: ['sports', 'poker'], macro: ['casino'] }, verification: 'outdated' })).toBe(
      'Matches the betting limits question (max, bet, limit), but it is about casino, not sports or poker; some of its facts are outdated.',
    );
  });

  it('explains a resolved money flow and joins a loose main clause with a semicolon', () => {
    expect(buildReason({ ...base, matchedTerms: ['BTC'], caveat: { kind: 'resolved', flow: 'deposit' } })).toBe(
      'Closest available macro, but only loosely related (BTC); the customer says the deposit already arrived.',
    );
  });

  it('drops terms, then the caveat, to stay within 160 characters', () => {
    const long = 'y'.repeat(60);
    const product = { kind: 'product', asked: ['sports'], macro: ['casino'] } as const;
    const reason = buildReason({ ...matched, matchedTerms: [long, long], caveat: product });
    expect(reason.length).toBeLessThanOrEqual(160);
    expect(reason).toBe(`Matches the betting limits question (${long}), but it is about casino, not sports.`);
    const tight = buildReason({ ...matched, coversIntents: ['betting_limits', 'casino_games', 'responsible_gambling'], matchedTerms: [long], caveat: product });
    expect(tight.length).toBeLessThanOrEqual(160);
    expect(tight).toMatch(/, but it is about casino, not sports\.$/);
  });
});

describe('displayTerm', () => {
  it('upper-cases tickers and acronyms only', () => {
    expect(displayTerm('btc')).toBe('BTC');
    expect(displayTerm('2fa')).toBe('2FA');
    expect(displayTerm('withdrawal')).toBe('withdrawal');
  });
});
