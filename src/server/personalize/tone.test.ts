import { describe, expect, it } from 'vitest';
import type { Analysis, Sentiment } from '../../shared/types.js';
import {
  APOLOGY_SENTENCES,
  CARE_SENTENCES,
  REASSURANCE_SENTENCES,
  THANKS_SENTENCES,
  applyTone,
  insertAfterGreeting,
} from './tone.js';

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    intents: [{ intent: 'withdrawal_pending', score: 0.8 }],
    sentiment: 'neutral',
    sentimentScore: 0,
    urgency: 'normal',
    urgencyReasons: [],
    entities: [],
    questions: [{ text: 'Where is my withdrawal?', intent: 'withdrawal_pending' }],
    keywords: ['withdrawal'],
    rgRisk: false,
    rgSignals: [],
    isLikelyNonEnglish: false,
    wordCount: 6,
    source: 'local',
    ...overrides,
  };
}

const BODY = 'Hi John,\n\nYour withdrawal is currently pending review.';
const ALL_SENTENCES: readonly string[] = [...APOLOGY_SENTENCES, ...REASSURANCE_SENTENCES, ...THANKS_SENTENCES, ...CARE_SENTENCES];

describe('sentence banks', () => {
  it('have at least 3 variants each', () => {
    for (const bank of [APOLOGY_SENTENCES, REASSURANCE_SENTENCES, THANKS_SENTENCES, CARE_SENTENCES]) {
      expect(bank.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('never admit fault or promise outcomes', () => {
    const forbidden = /\b(?:our (?:fault|mistake|error)|we (?:made|messed)|we will (?:fix|resolve|refund|credit)|guarantee|promise|will be (?:resolved|credited|fixed)|definitely|right away|asap)\b/i;
    for (const sentence of ALL_SENTENCES) expect(sentence).not.toMatch(forbidden);
  });

  it('keeps the RG bank calm (no exclamation marks, no cheerful words)', () => {
    for (const sentence of CARE_SENTENCES) {
      expect(sentence).not.toMatch(/!|great|glad|happy|awesome|excited|good luck/i);
    }
  });
});

describe('applyTone', () => {
  it('does nothing when disabled', () => {
    expect(applyTone(BODY, analysis({ sentiment: 'angry' }), false)).toEqual({ text: BODY, added: [] });
  });

  it('does nothing for neutral messages', () => {
    expect(applyTone(BODY, analysis(), true)).toEqual({ text: BODY, added: [] });
  });

  it.each<[Sentiment, readonly string[]]>([
    ['angry', APOLOGY_SENTENCES],
    ['frustrated', APOLOGY_SENTENCES],
    ['confused', REASSURANCE_SENTENCES],
    ['positive', THANKS_SENTENCES],
  ])('adds a %s sentence from the right bank right after the greeting line', (sentiment, bank) => {
    const result = applyTone(BODY, analysis({ sentiment }), true);
    expect(result.added).toHaveLength(1);
    const sentence = result.added[0] ?? '';
    expect(bank).toContain(sentence);
    expect(result.text).toBe(`Hi John,\n\n${sentence} Your withdrawal is currently pending review.`);
  });

  it('is deterministic for the same message', () => {
    const a = analysis({ sentiment: 'angry', keywords: ['withdrawal', 'stuck'], wordCount: 12 });
    expect(applyTone(BODY, a, true)).toEqual(applyTone(BODY, { ...a }, true));
  });

  it('varies the phrasing across different messages', () => {
    const picked = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const a = analysis({ sentiment: 'frustrated', wordCount: i + 3, keywords: [`k${i}`] });
      picked.add(applyTone(BODY, a, true).added[0] ?? '');
    }
    expect(picked.size).toBeGreaterThanOrEqual(2);
  });

  it.each([
    'Hi John,\n\nWe are sorry for the delay, your withdrawal is pending.',
    'Hi John,\n\nWe apologise for the wait.',
    'Hi John,\n\nPlease accept our apologies.',
    'Hi John,\n\nI understand how frustrating it is to wait.',
  ])('does not double-apologize: %j', (text) => {
    expect(applyTone(text, analysis({ sentiment: 'angry' }), true)).toEqual({ text, added: [] });
  });

  it('does not add thanks when the body already thanks the customer', () => {
    const text = 'Hi John,\n\nThank you for contacting us. Your bonus is active.';
    expect(applyTone(text, analysis({ sentiment: 'positive' }), true).added).toEqual([]);
  });

  it('does not add reassurance when the body already reassures', () => {
    const text = 'Hi John,\n\nNo worries, you can reset your password in a few steps.';
    expect(applyTone(text, analysis({ sentiment: 'confused' }), true).added).toEqual([]);
  });

  it('is idempotent (applying twice adds only one sentence)', () => {
    for (const sentiment of ['angry', 'confused', 'positive'] as const) {
      const once = applyTone(BODY, analysis({ sentiment }), true).text;
      expect(applyTone(once, analysis({ sentiment }), true).added).toEqual([]);
    }
    const rg = analysis({ rgRisk: true, sentiment: 'angry' });
    expect(applyTone(applyTone(BODY, rg, true).text, rg, true).added).toEqual([]);
  });

  describe('responsible gambling risk', () => {
    it('uses a calm caring sentence instead of thanks for positive messages', () => {
      const result = applyTone(BODY, analysis({ sentiment: 'positive', rgRisk: true }), true);
      expect(CARE_SENTENCES).toContain(result.added[0]);
      expect(THANKS_SENTENCES).not.toContain(result.added[0]);
    });

    it('uses a caring sentence for angry and neutral messages too', () => {
      for (const sentiment of ['angry', 'frustrated', 'neutral', 'confused'] as const) {
        const result = applyTone(BODY, analysis({ sentiment, rgRisk: true }), true);
        expect(CARE_SENTENCES).toContain(result.added[0]);
      }
    });

    it('skips when the body already contains a caring line', () => {
      const text = "Hi John,\n\nThank you for reaching out, we're here to support you.";
      expect(applyTone(text, analysis({ sentiment: 'positive', rgRisk: true }), true).added).toEqual([]);
    });
  });
});

describe('insertAfterGreeting', () => {
  const S = 'No worries, I will walk you through it.';

  it('keeps a greeting ending with a comma on its own line', () => {
    expect(insertAfterGreeting('Hi John,\nHere is how it works.', S)).toBe(`Hi John,\n${S} Here is how it works.`);
  });

  it('moves an inline greeting ending with a comma onto its own line and capitalizes the continuation', () => {
    expect(insertAfterGreeting('Hi John, your withdrawal is pending.', S)).toBe(`Hi John,\n\n${S} Your withdrawal is pending.`);
    expect(insertAfterGreeting('Hi John, 1. Open Settings', S)).toBe(`Hi John,\n\n${S}\n\n1. Open Settings`);
  });

  it("keeps an inline greeting ending with '!' on the same line", () => {
    expect(insertAfterGreeting('Hi John! your withdrawal is pending.', S)).toBe(`Hi John! ${S} Your withdrawal is pending.`);
  });

  it('does not upper-case camel-cased words such as iOS', () => {
    expect(insertAfterGreeting('Hi John,\n\niOS app users can update in the App Store.', S)).toBe(
      `Hi John,\n\n${S} iOS app users can update in the App Store.`,
    );
    expect(insertAfterGreeting('Hi John, eSports bets settle later.', S)).toBe(`Hi John,\n\n${S} eSports bets settle later.`);
  });

  it('puts the sentence on its own paragraph before lists and placeholders', () => {
    expect(insertAfterGreeting('Hi John,\n\n1. Open Settings\n2. Click Security', S)).toBe(`Hi John,\n\n${S}\n\n1. Open Settings\n2. Click Security`);
    expect(insertAfterGreeting('Hi there,\n\n[ENTER ANSWER ABOUT KYC]', S)).toBe(`Hi there,\n\n${S}\n\n[ENTER ANSWER ABOUT KYC]`);
  });

  it('handles a greeting-only text', () => {
    expect(insertAfterGreeting('Hi John,', S)).toBe(`Hi John,\n\n${S}`);
  });

  it('prepends when there is no greeting', () => {
    expect(insertAfterGreeting('your withdrawal is pending.', S)).toBe(`${S} Your withdrawal is pending.`);
  });
});
