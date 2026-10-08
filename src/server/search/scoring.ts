/**
 * Score components and confidence calibration for macro recommendations.
 *
 * combined = (0.42*semantic + 0.30*lexical + 0.22*intent + 0.06*usage) * relevanceFactor   (components 0..1)
 * confidence = logistic(combined), calibrated on the labeled fixture set in macroIndex.accuracy.test.ts so that
 * clear matches land around 75-95, partial matches 45-70 and unrelated messages below 35.
 *
 * The relevance factor (see signals.ts) handles two near-topic cases the components cannot see: a macro specific to
 * another product (casino vs sports vs poker) than the one the customer names, and missing/pending macros for money
 * the customer says already arrived. It is multiplicative rather than a logistic recalibration, so clear matches
 * keep their confidence.
 */
import type { Analysis, EmbedderStatus, Intent, ScoreBreakdown } from '../../shared/types.js';

export const WEIGHTS = { semantic: 0.42, lexical: 0.3, intent: 0.22, usage: 0.06 } as const;

/**
 * Raw cosine range mapped onto 0..1 per provider. Hashing vectors of unrelated texts sit near 0 while neural
 * models rarely go below ~0.4 even for unrelated text, so one fixed scale would mis-rank across providers.
 */
export const SEMANTIC_CALIBRATION: Record<EmbedderStatus['provider'], { lo: number; hi: number }> = {
  builtin: { lo: 0.08, hi: 0.75 },
  transformers: { lo: 0.45, hi: 0.85 },
  ollama: { lo: 0.4, hi: 0.82 },
};

/** Weight of the body passage relative to the head passage (title, triggers, intents, tags). */
export const BODY_FACTOR = 0.85;

/**
 * Lexical saturation: lexical = bm25/maxBm25 * (1 - exp(-maxBm25 / LEXICAL_SCALE)), so a weak best hit
 * (one common word in the body) stays weak instead of being normalized to 1.
 */
export const LEXICAL_SCALE = 60;

/** Logistic confidence curve: 50% at combined = CONFIDENCE_MIDPOINT, slope CONFIDENCE_SLOPE. */
export const CONFIDENCE_MIDPOINT = 0.45;
export const CONFIDENCE_SLOPE = 6.5;

/**
 * Relevance adjustments, multiplied into the combined score (so they affect both rank and confidence): a macro
 * specific to another product (casino vs sports vs poker) than the one the customer names keeps
 * PRODUCT_MISMATCH_FACTOR; a missing-deposit / pending-withdrawal macro keeps RESOLVED_FACTOR when the customer says
 * that money already arrived.
 *
 * There is deliberately no "concept coverage" penalty (share of the question's domain concepts the macro mentions):
 * it was tried, and on blind holdout sets it penalized correct macros (customers' state words such as "disappeared",
 * "froze" or "app" that the right macro does not repeat) at least as often as the top macro of unanswerable
 * messages, so it did not generalize.
 */
export const PRODUCT_MISMATCH_FACTOR = 0.5;
export const RESOLVED_FACTOR = 0.7;

export interface RelevanceSignals {
  productMismatch: boolean;
  /** The macro is about a missing/pending money flow the customer reports as resolved. */
  resolvedConflict: boolean;
}

/** Multiplier (0..1] applied to the combined score for the relevance signals. */
export function relevanceFactor(s: RelevanceSignals): number {
  let f = 1;
  if (s.productMismatch) f *= PRODUCT_MISMATCH_FACTOR;
  if (s.resolvedConflict) f *= RESOLVED_FACTOR;
  return f;
}

/** Minimum analysis score for an intent to count as "asked" (diversification, uncovered intents). */
export const WANTED_INTENT_MIN_SCORE = 0.35;
/** Score given to a question-span intent that the analysis did not score itself. */
const QUESTION_INTENT_SCORE = 0.5;
const RELATED_INTENT_FACTOR = 0.5;

const RELATED_GROUPS: Intent[][] = [
  ['withdrawal_pending', 'withdrawal_help', 'withdrawal_limits'],
  ['deposit_missing', 'deposit_help'],
  ['deposit_help', 'payment_methods'],
  ['withdrawal_help', 'payment_methods'],
  ['account_access', 'account_security'],
  ['account_closure', 'responsible_gambling'],
  ['bonus_inquiry', 'wagering_requirement'],
  ['bonus_inquiry', 'vip_program'],
  ['sports_betting', 'betting_limits'],
];

/** Intents that count half when a macro is tagged with one and the customer asked about the other. */
export const RELATED_INTENTS: ReadonlyMap<Intent, ReadonlySet<Intent>> = (() => {
  const map = new Map<Intent, Set<Intent>>();
  for (const group of RELATED_GROUPS) {
    for (const a of group) {
      const set = map.get(a) ?? new Set<Intent>();
      for (const b of group) if (b !== a) set.add(b);
      map.set(a, set);
    }
  }
  return map;
})();

function clamp01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

/** Map a raw cosine similarity onto 0..1 for the given provider. */
export function calibrateSemantic(provider: EmbedderStatus['provider'], cos: number): number {
  const { lo, hi } = SEMANTIC_CALIBRATION[provider];
  return clamp01((cos - lo) / (hi - lo));
}

/** 0..1 lexical score of one document given the best BM25 score among all candidates. */
export function lexicalScore(bm25: number, maxBm25: number): number {
  if (maxBm25 <= 0 || bm25 <= 0) return 0;
  return clamp01(bm25 / maxBm25) * (1 - Math.exp(-maxBm25 / LEXICAL_SCALE));
}

/** Usage prior: 60% log-scaled use count relative to the most used macro, 40% favorite flag. */
export function usageScore(useCount: number, maxUseCount: number, isFavorite: boolean): number {
  const used = maxUseCount > 0 ? Math.log1p(Math.max(0, useCount)) / Math.log1p(maxUseCount) : 0;
  return clamp01(0.6 * used + (isFavorite ? 0.4 : 0));
}

/** Weighted sum of the components. Without a query vector the remaining weights are rescaled to sum to 1. */
export function combineScores(b: ScoreBreakdown, semanticAvailable: boolean): number {
  if (semanticAvailable) {
    return WEIGHTS.semantic * b.semantic + WEIGHTS.lexical * b.lexical + WEIGHTS.intent * b.intent + WEIGHTS.usage * b.usage;
  }
  const rest = WEIGHTS.lexical + WEIGHTS.intent + WEIGHTS.usage;
  return (WEIGHTS.lexical * b.lexical + WEIGHTS.intent * b.intent + WEIGHTS.usage * b.usage) / rest;
}

/** Calibrated confidence 0..100 (integer). */
export function confidenceOf(combined: number): number {
  return Math.round(100 / (1 + Math.exp(-CONFIDENCE_SLOPE * (combined - CONFIDENCE_MIDPOINT))));
}

/**
 * How strongly the customer asked about each intent: analysis.intents scores, plus question-span intents
 * (at least QUESTION_INTENT_SCORE, since the analyzer found a dedicated question for them). A 'general' question
 * is the analyzer's label for an unclassified one, so it gets no floor (it would boost every 'general' macro).
 */
export function intentWeights(analysis: Analysis): Map<Intent, number> {
  const weights = new Map<Intent, number>();
  for (const { intent, score } of analysis.intents) weights.set(intent, Math.max(weights.get(intent) ?? 0, clamp01(score)));
  for (const q of analysis.questions) {
    if (q.intent && q.intent !== 'general') weights.set(q.intent, Math.max(weights.get(q.intent) ?? 0, QUESTION_INTENT_SCORE));
  }
  return weights;
}

export interface IntentMatch {
  score: number;
  /** Customer intent matched only through a related macro intent (null for exact matches or no match). */
  relatedTo: Intent | null;
}

/** Best match between a macro's intents and the customer's intent weights; related intents count half. */
export function matchIntents(macroIntents: readonly Intent[], weights: ReadonlyMap<Intent, number>): IntentMatch {
  let score = 0;
  let relatedTo: Intent | null = null;
  for (const mi of macroIntents) {
    const exact = weights.get(mi) ?? 0;
    if (exact >= score && exact > 0) {
      score = exact;
      relatedTo = null;
    }
    for (const r of RELATED_INTENTS.get(mi) ?? []) {
      const related = (weights.get(r) ?? 0) * RELATED_INTENT_FACTOR;
      if (related > score) {
        score = related;
        relatedTo = r;
      }
    }
  }
  return { score, relatedTo };
}

/**
 * Intents the customer clearly asked about, strongest first: analysis intents with score >= 0.35 and every
 * question-span intent. 'general' is never "wanted" (there is nothing specific to cover).
 */
export function wantedIntents(analysis: Analysis, weights: ReadonlyMap<Intent, number>): Intent[] {
  const wanted = new Set<Intent>();
  for (const { intent, score } of analysis.intents) if (score >= WANTED_INTENT_MIN_SCORE) wanted.add(intent);
  for (const q of analysis.questions) if (q.intent) wanted.add(q.intent);
  wanted.delete('general');
  return [...wanted].sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0));
}

/** True when the message asks about more than one thing (>= 2 question intents or a strong 2nd intent). */
export function isMultiTopic(analysis: Analysis): boolean {
  const questionIntents = new Set(analysis.questions.flatMap((q) => (q.intent && q.intent !== 'general' ? [q.intent] : [])));
  if (questionIntents.size >= 2) return true;
  return analysis.intents.slice(1).some((i) => i.score >= WANTED_INTENT_MIN_SCORE && i.intent !== 'general');
}
