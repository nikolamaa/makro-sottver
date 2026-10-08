/**
 * Local, deterministic, dependency-free message analyzer (target: < 5 ms per message).
 * Uses the domain vocabulary in ../domain/igaming.ts. No network, no LLM.
 */
import type { Analysis, Entity, Intent, IntentScore, QuestionSpan, Sentiment, Urgency } from '../../shared/types.js';

/** Full analysis of a customer message (English). Empty/whitespace input returns a neutral, empty analysis. */
export function analyzeMessage(text: string): Analysis {
  throw new Error('TODO');
}

/** Intent scores (0..1), sorted desc, max 3, only intents with score >= 0.15; falls back to [{general, x}]. */
export function scoreIntents(text: string): IntentScore[] {
  throw new Error('TODO');
}

export function extractEntities(text: string): Entity[] {
  throw new Error('TODO');
}

export function detectSentiment(text: string): { sentiment: Sentiment; score: number } {
  throw new Error('TODO');
}

export function detectUrgency(
  text: string,
  ctx: { sentiment: Sentiment; entities: Entity[]; rgCritical: boolean },
): { urgency: Urgency; reasons: string[] } {
  throw new Error('TODO');
}

/** Split into distinct questions/requests and classify each one. Non-question chatter is dropped. */
export function splitQuestions(text: string): QuestionSpan[] {
  throw new Error('TODO');
}

export function detectRgRisk(text: string): { risk: boolean; critical: boolean; signals: string[] } {
  throw new Error('TODO');
}

/** Salient lowercase keywords (stopwords removed, domain terms first), max 12. */
export function extractKeywords(text: string): string[] {
  throw new Error('TODO');
}

/** Heuristic: true when the text is probably not English (e.g. mostly non-Latin script or no English function words). */
export function isLikelyNonEnglish(text: string): boolean {
  throw new Error('TODO');
}

export type { Intent };
