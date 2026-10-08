/**
 * Test fixtures for the Assist modules (imported only by *.test.ts files).
 */
import { detectedVariables } from './variables';
import type { Analysis, DraftResponse, Macro, PersonalizeResponse, Recommendation, RecommendResponse, RerankResponse } from '../../../shared/types';

export function analysisFixture(partial: Partial<Analysis> = {}): Analysis {
  return {
    intents: [{ intent: 'withdrawal_pending', score: 0.82 }],
    sentiment: 'frustrated',
    sentimentScore: -0.4,
    urgency: 'high',
    urgencyReasons: ['waiting 3 days'],
    entities: [{ type: 'name', value: 'Marko', raw: 'Marko', start: 0, end: 5 }],
    questions: [{ text: 'Where is my withdrawal?', intent: 'withdrawal_pending' }],
    keywords: ['withdrawal'],
    rgRisk: false,
    rgSignals: [],
    isLikelyNonEnglish: false,
    wordCount: 12,
    source: 'local',
    ...partial,
  };
}

export function recommendationFixture(macroId: string, partial: Partial<Recommendation> = {}): Recommendation {
  return {
    macroId,
    title: `Macro ${macroId}`,
    categoryId: null,
    confidence: 82,
    reason: 'Matches the pending withdrawal question.',
    matchedTerms: ['withdrawal', 'pending'],
    coversIntents: ['withdrawal_pending'],
    verification: 'verified',
    warnings: [],
    breakdown: { semantic: 0.8, lexical: 0.7, intent: 1, usage: 0.1 },
    ...partial,
  };
}

export function resultFixture(partial: Partial<RecommendResponse> = {}): RecommendResponse {
  const analysis = partial.analysis ?? analysisFixture();
  return {
    analysis,
    detectedVariables: detectedVariables(analysis.entities),
    recommendations: [recommendationFixture('a'), recommendationFixture('b', { confidence: 61 }), recommendationFixture('c', { confidence: 40 })],
    noGoodMatch: false,
    uncoveredIntents: [],
    embeddings: { provider: 'builtin', model: 'concepts', state: 'ready', detail: '' },
    timingMs: { analysis: 2, search: 9, total: 11 },
    ...partial,
  };
}

export function personalizeFixture(text: string, partial: Partial<PersonalizeResponse> = {}): PersonalizeResponse {
  return {
    text,
    mode: 'fast',
    filledVariables: {},
    placeholders: [],
    usedFactIds: [],
    unansweredQuestions: [],
    guardrail: [],
    warnings: [],
    llm: null,
    ...partial,
  };
}

export function draftFixture(text: string, partial: Partial<DraftResponse> = {}): DraftResponse {
  return {
    text,
    suggestedTitle: 'Where is my withdrawal?',
    suggestedIntents: ['withdrawal_pending'],
    placeholders: [],
    guardrail: [],
    warnings: ['AI is off: this is an empty reply skeleton.'],
    llm: null,
    ...partial,
  };
}

/** An AI double-check answer (AI used, good match) with the given ranking. */
export function rerankFixture(recommendations: Recommendation[], partial: Partial<RerankResponse> = {}): RerankResponse {
  return { recommendations, noGoodMatch: false, aiUsed: true, llm: null, ...partial };
}

export function macroFixture(id: string, useCount = 0, partial: Partial<Macro> = {}): Macro {
  return {
    id,
    title: `Macro ${id}`,
    body: 'Hi {{user|there}}, thanks for reaching out.',
    categoryId: null,
    tags: [],
    intents: [],
    triggers: [],
    notes: '',
    shortcut: '',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    isFavorite: false,
    useCount,
    lastUsedAt: null,
    verification: 'unverified',
    facts: [],
    ...partial,
  };
}
