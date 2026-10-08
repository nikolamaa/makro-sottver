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

describe('displayTerm', () => {
  it('upper-cases tickers and acronyms only', () => {
    expect(displayTerm('btc')).toBe('BTC');
    expect(displayTerm('2fa')).toBe('2FA');
    expect(displayTerm('withdrawal')).toBe('withdrawal');
  });
});
