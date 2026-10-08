import { describe, expect, it } from 'vitest';
import type { QuestionSpan } from '../../shared/types.js';
import { conceptIdsOf, contentTerms, isProductMismatch, macroProducts, messageSignals, productsOf } from './signals.js';

const signalsOf = (message: string, questions: QuestionSpan[] = []) => messageSignals(message, { questions });

describe('resolved money flows', () => {
  it('detects a deposit or withdrawal the customer says already arrived', () => {
    const s = signalsOf('thanks guys, deposit arrived! quick q - how long does swapping btc to ltc take in the wallet?');
    expect([...s.resolved]).toEqual(['deposit']);
    // The resolved clause is context: its words are not part of the question.
    expect(s.resolvedTerms.has('deposit')).toBe(true);
    expect(s.questions[0]!.concepts.has('deposit')).toBe(false);
    expect(s.questions[0]!.concepts.has('crypto')).toBe(true);
    expect([...signalsOf('got my withdrawal, thanks. also when is the weekly bonus sent?').resolved]).toEqual(['withdrawal']);
    expect([...signalsOf('the deposit was credited, now how do i withdraw it?').resolved]).toEqual(['deposit']);
  });

  it('ignores negated, doubted, partial and asked-about arrivals', () => {
    for (const message of [
      "my deposit hasn't arrived yet",
      'I sent 500 USDT and NOTHING arrived.',
      'has my withdrawal arrived?',
      'i got my withdrawal denied twice',
      'I received only half of my withdrawal',
      'my first deposit arrived but the second deposit is still missing',
    ]) {
      expect([...signalsOf(message).resolved], message).toEqual([]);
    }
  });

  it('keeps a flow open when another clause reports it as a problem', () => {
    const s = signalsOf('Withdrawal finally came through, thanks! But my deposit is still pending');
    expect([...s.resolved]).toEqual(['withdrawal']);
    expect(s.questions[0]!.concepts.has('deposit')).toBe(true);
  });
});

describe('question focus', () => {
  it('lists non-generic concepts (typos included) and content terms', () => {
    expect([...conceptIdsOf('my withdrawl is stuck since yesterday, this is ridiculous')].sort()).toEqual(['pending', 'withdrawal']);
    expect([...contentTerms('whats going on with my btc withdrawal, it takes forever')].sort()).toEqual(['btc', 'withdrawal']);
  });

  it('adds one focus per question span only for multi-question messages', () => {
    expect(signalsOf('my btc withdrawal is pending', [{ text: 'my btc withdrawal is pending', intent: 'withdrawal_pending' }]).questions).toHaveLength(1);
    const s = signalsOf('my btc withdrawal is pending. also when is the weekly bonus sent?', [
      { text: 'my btc withdrawal is pending.', intent: 'withdrawal_pending' },
      { text: 'also when is the weekly bonus sent?', intent: 'bonus_inquiry' },
    ]);
    expect(s.questions.map((q) => q.intent)).toEqual([null, 'withdrawal_pending', 'bonus_inquiry']);
    expect([...s.questions[2]!.concepts].sort()).toEqual(['bonus', 'weekly_bonus']);
  });
});

describe('products', () => {
  it('detects products from unambiguous words only', () => {
    expect([...productsOf('can you raise my max bet limit on tennis matches?')]).toEqual(['sports']);
    expect([...productsOf('pls exclude me from poker only, i still wanna bet on football')].sort()).toEqual(['poker', 'sports']);
    expect([...productsOf('whats the minimum bet on plinko')]).toEqual(['casino']);
    // "game", "match", "goal" and "crash" alone are ambiguous.
    expect([...productsOf('the game crashed during the match, my goal was to withdraw')]).toEqual([]);
  });

  it('takes macro products from the title and product intents, not passing mentions in the body', () => {
    expect([...macroProducts({ title: 'Casino betting limits (min / max bet)', intents: ['betting_limits'] })]).toEqual(['casino']);
    expect([...macroProducts({ title: 'Voided Bet Explained', intents: ['sports_betting'] })]).toEqual(['sports']);
    expect([...macroProducts({ title: 'VIP Progress: what is left to the next level', intents: ['vip_program'] })]).toEqual([]);
  });

  it('reports a mismatch only between product-specific message and macro without overlap', () => {
    const sports = new Set(['sports'] as const);
    expect(isProductMismatch(sports, new Set(['casino'] as const))).toBe(true);
    expect(isProductMismatch(sports, new Set(['casino', 'sports'] as const))).toBe(false);
    expect(isProductMismatch(sports, new Set())).toBe(false);
    expect(isProductMismatch(new Set(), new Set(['casino'] as const))).toBe(false);
  });
});
