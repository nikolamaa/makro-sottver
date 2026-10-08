import { describe, expect, it } from 'vitest';
import { findConcepts, normalizeForMatch } from '../domain/igaming.js';
import { conceptWeight, prepare, scanConcepts } from './concepts.js';

function concepts(text: string): Record<string, readonly string[]> {
  return Object.fromEntries(scanConcepts(normalizeForMatch(text)).byConcept);
}

describe('scanConcepts', () => {
  it('finds the same concepts as findConcepts for plain phrases', () => {
    const text = 'my btc cashout is stuck';
    expect(concepts(text)).toEqual(Object.fromEntries(findConcepts(text)));
  });

  it('prefers the longest phrase and never double-counts its words', () => {
    expect(concepts('I uploaded my id card')).toEqual({ kyc: ['id card'] });
    expect(concepts('please set a deposit limit')).toEqual({ responsible_gambling: ['deposit limit'] });
    expect(concepts('why is my max bet so low')).toEqual({ bet_limits: ['max bet'] });
    expect(concepts("I can't log in")).toEqual({ access: ["can't log in"] });
  });

  it('maps a phrase shared by several concepts to all of them', () => {
    expect(concepts('how long does it take')).toEqual({ pending: ['how long'], time: ['how long'] });
  });

  it('lists unique terms in order of appearance', () => {
    expect(scanConcepts(normalizeForMatch('Withdrawal pending, withdrawal still pending')).terms).toEqual(['withdrawal', 'pending']);
    expect(scanConcepts('').terms).toEqual([]);
  });
});

describe('conceptWeight', () => {
  it('uses the strongest term plus a small bonus for extra terms', () => {
    const p = prepare('weekly bonus and a promo code');
    expect(conceptWeight(p, 'bonus', 2, { code: 0.5 })).toBe(2);
    expect(conceptWeight(prepare('promo and offer'), 'bonus', 2, { offer: 0.8 })).toBe(2.25);
    expect(conceptWeight(p, 'kyc', 2)).toBe(0);
  });
});
