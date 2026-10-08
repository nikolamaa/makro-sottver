import { describe, expect, it } from 'vitest';
import type { Analysis, Intent, QuestionSpan } from '../../shared/types.js';
import {
  calibrateSemantic,
  combineScores,
  confidenceOf,
  intentWeights,
  isMultiTopic,
  lexicalScore,
  matchIntents,
  usageScore,
  wantedIntents,
} from './scoring.js';

function analysisOf(intents: [Intent, number][], questions: QuestionSpan[] = []): Analysis {
  return {
    intents: intents.map(([intent, score]) => ({ intent, score })),
    sentiment: 'neutral',
    sentimentScore: 0,
    urgency: 'normal',
    urgencyReasons: [],
    entities: [],
    questions,
    keywords: [],
    rgRisk: false,
    rgSignals: [],
    isLikelyNonEnglish: false,
    wordCount: 0,
    source: 'local',
  };
}

describe('score components', () => {
  it('calibrates cosine per provider into 0..1', () => {
    expect(calibrateSemantic('builtin', 0)).toBe(0);
    expect(calibrateSemantic('builtin', 0.95)).toBe(1);
    expect(calibrateSemantic('transformers', 0.45)).toBe(0);
    expect(calibrateSemantic('transformers', 0.65)).toBeCloseTo(0.5, 5);
    // The same raw cosine means much less for a neural model than for hashing vectors.
    expect(calibrateSemantic('transformers', 0.5)).toBeLessThan(calibrateSemantic('builtin', 0.5));
  });

  it('keeps a weak best lexical hit weak', () => {
    expect(lexicalScore(0, 100)).toBe(0);
    expect(lexicalScore(400, 400)).toBeGreaterThan(0.99);
    expect(lexicalScore(6, 6)).toBeLessThan(0.15);
    expect(lexicalScore(200, 400)).toBeCloseTo(0.5, 2);
  });

  it('scores usage from use count and favorite flag', () => {
    expect(usageScore(0, 0, false)).toBe(0);
    expect(usageScore(10, 10, true)).toBe(1);
    expect(usageScore(3, 15, false)).toBeCloseTo((0.6 * Math.log1p(3)) / Math.log1p(15), 5);
  });

  it('combines with the documented weights and redistributes the semantic weight when missing', () => {
    const b = { semantic: 1, lexical: 0.5, intent: 1, usage: 0 };
    expect(combineScores(b, true)).toBeCloseTo(0.42 + 0.15 + 0.22, 5);
    expect(combineScores({ ...b, semantic: 0 }, false)).toBeCloseTo((0.15 + 0.22) / 0.58, 5);
  });

  it('maps combined scores onto calibrated confidence bands', () => {
    expect(confidenceOf(0.85)).toBeGreaterThanOrEqual(90);
    expect(confidenceOf(0.65)).toBeGreaterThanOrEqual(75);
    expect(confidenceOf(0.45)).toBe(50);
    expect(confidenceOf(0.1)).toBeLessThan(15);
    for (let x = 0; x < 1; x += 0.05) expect(confidenceOf(x + 0.05)).toBeGreaterThanOrEqual(confidenceOf(x));
  });
});

describe('intent matching', () => {
  it('uses analysis scores and gives question intents a floor', () => {
    const w = intentWeights(analysisOf([['withdrawal_pending', 0.9]], [{ text: 'and kyc?', intent: 'kyc_verification' }]));
    expect(w.get('withdrawal_pending')).toBe(0.9);
    expect(w.get('kyc_verification')).toBe(0.5);
  });

  it('counts related intents at half weight', () => {
    const w = new Map<Intent, number>([['withdrawal_pending', 0.8]]);
    expect(matchIntents(['withdrawal_pending'], w)).toEqual({ score: 0.8, relatedTo: null });
    expect(matchIntents(['withdrawal_limits'], w)).toEqual({ score: 0.4, relatedTo: 'withdrawal_pending' });
    expect(matchIntents(['account_closure'], new Map([['responsible_gambling', 1]]))).toEqual({ score: 0.5, relatedTo: 'responsible_gambling' });
    expect(matchIntents(['vip_program'], w)).toEqual({ score: 0, relatedTo: null });
  });

  it('lists wanted intents strongest first without general', () => {
    const a = analysisOf(
      [
        ['general', 0.5],
        ['kyc_verification', 0.4],
        ['bonus_inquiry', 0.2],
      ],
      [{ text: 'my withdrawal?', intent: 'withdrawal_pending' }],
    );
    expect(wantedIntents(a, intentWeights(a))).toEqual(['withdrawal_pending', 'kyc_verification']);
  });

  it('detects multi-topic messages', () => {
    expect(isMultiTopic(analysisOf([['withdrawal_pending', 0.9]]))).toBe(false);
    expect(isMultiTopic(analysisOf([['withdrawal_pending', 0.9], ['general', 0.5]]))).toBe(false);
    expect(isMultiTopic(analysisOf([['withdrawal_pending', 0.9], ['kyc_verification', 0.35]]))).toBe(true);
    expect(
      isMultiTopic(
        analysisOf(
          [['withdrawal_pending', 0.9]],
          [
            { text: 'a', intent: 'withdrawal_pending' },
            { text: 'b', intent: 'vip_program' },
          ],
        ),
      ),
    ).toBe(true);
  });
});
