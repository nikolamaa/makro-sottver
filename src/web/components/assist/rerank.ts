/**
 * AI double-check of the recommendations (pure). After the instant local result is shown, POST /api/rerank lets
 * the AI re-score the local candidates. The answer never reorders the cards - Alt+1..3 keep pointing at the same
 * macros - it only updates confidence/reason in place, marks the AI's top pick, offers the AI's top pick when it
 * is not among the cards, and flags when the AI finds no macro that fully answers the message.
 */
import type { Id, Recommendation, RecommendResponse, RerankResponse } from '../../../shared/types';

export type RerankStatus = 'idle' | 'running' | 'done' | 'failed';

export interface AiScore {
  confidence: number;
  reason: string;
}

export interface RerankState {
  /** Message (the result's resultFor) the check belongs to; '' while idle. */
  message: string;
  status: RerankStatus;
  /** AI confidence and reason per card (macro id) the AI re-scored. */
  scores: Record<Id, AiScore>;
  /** The AI's best macro, when it found one that fits. */
  topId: Id | null;
  /** The AI's best macro when it is not among the cards (offered with Alt+4). */
  suggestion: Recommendation | null;
  /** The AI finds no macro that fully answers the message, although the local match did. */
  noGoodMatch: boolean;
}

export const IDLE_RERANK: RerankState = { message: '', status: 'idle', scores: {}, topId: null, suggestion: null, noGoodMatch: false };

/** State after the AI answered for `message`, whose local result is `local`. */
export function rerankOutcome(message: string, local: RecommendResponse, res: RerankResponse): RerankState {
  const done: RerankState = { ...IDLE_RERANK, message, status: 'done' };
  if (!res.aiUsed) return done;
  const shown = new Set(local.recommendations.map((r) => r.macroId));
  const scores: Record<Id, AiScore> = {};
  for (const r of res.recommendations) {
    if (shown.has(r.macroId)) scores[r.macroId] = { confidence: r.confidence, reason: r.reason };
  }
  // A top pick only counts when the AI thinks it fits.
  const top = res.noGoodMatch ? undefined : res.recommendations[0];
  return {
    ...done,
    scores,
    topId: top?.macroId ?? null,
    suggestion: top && !shown.has(top.macroId) ? top : null,
    noGoodMatch: res.noGoodMatch && !local.noGoodMatch,
  };
}

/** A card as displayed: the local recommendation with the AI's confidence/reason applied in place. */
export interface ShownRecommendation {
  rec: Recommendation;
  /** Confidence before the AI re-scored it (equals rec.confidence when it did not). */
  localConfidence: number;
  aiScored: boolean;
  aiPick: boolean;
}

/** Cards in the local order (never reordered), with the AI scores of a finished double-check. */
export function shownRecommendations(recs: readonly Recommendation[], rerank: RerankState): ShownRecommendation[] {
  return recs.map((rec) => {
    const ai = rerank.scores[rec.macroId];
    return {
      rec: ai ? { ...rec, confidence: ai.confidence, reason: ai.reason || rec.reason } : rec,
      localConfidence: rec.confidence,
      aiScored: ai !== undefined,
      aiPick: rerank.topId === rec.macroId,
    };
  });
}
