/**
 * Hybrid ranking of indexed macros for one customer message: candidate selection, score components,
 * calibrated confidence, multi-question diversification and explanations. Pure and synchronous; the
 * MacroIndex supplies the lexical hits and the query vector.
 */
import type { Analysis, EmbedderStatus, Id, Intent, Macro, Recommendation, ScoreBreakdown } from '../../shared/types.js';
import { verificationWarnings } from '../../shared/verification.js';
import { cosine } from './embedder.js';
import { buildReason, displayTerm } from './explain.js';
import type { LexicalHit } from './lexical.js';
import type { LexicalQuery } from './query.js';
import {
  BODY_FACTOR,
  calibrateSemantic,
  combineScores,
  confidenceOf,
  intentWeights,
  isMultiTopic,
  lexicalScore,
  matchIntents,
  usageScore,
  wantedIntents,
  type IntentMatch,
} from './scoring.js';

/** A macro as held by the index: decrypted content, passage vectors and the concepts it mentions. */
export interface IndexedMacro {
  macro: Macro;
  head: Float32Array | null;
  body: Float32Array | null;
  concepts: ReadonlySet<string>;
}

export interface RankInput {
  entries: ReadonlyMap<Id, IndexedMacro>;
  provider: EmbedderStatus['provider'];
  /** Null when the query could not be embedded (semantic weight is then redistributed). */
  queryVector: Float32Array | null;
  query: LexicalQuery;
  /** Sorted by score, best first. */
  lexicalHits: LexicalHit[];
  analysis: Analysis;
  maxResults: number;
  minConfidence: number;
}

export interface RankResult {
  recommendations: Recommendation[];
  noGoodMatch: boolean;
  uncoveredIntents: Intent[];
}

/** Candidates taken from each retrieval source (lexical and vector). */
export const CANDIDATES_PER_SOURCE = 40;
/** A secondary-question macro is only promoted to #2 when it is at least this confident. */
export const MIN_DIVERSIFY_CONFIDENCE = 35;
const MAX_MATCHED_TERMS = 6;
/** Concepts too generic to explain a match ("when", "account"). */
const UNEXPLAINING_CONCEPTS: ReadonlySet<string> = new Set(['time', 'account']);

interface Scored {
  item: IndexedMacro;
  breakdown: ScoreBreakdown;
  combined: number;
  confidence: number;
  intent: IntentMatch;
}

/** Raw semantic similarity: best of head passage and (discounted) body passage. */
function rawSemantic(query: Float32Array, item: IndexedMacro): number {
  const head = item.head ? cosine(query, item.head) : 0;
  const body = item.body ? BODY_FACTOR * cosine(query, item.body) : 0;
  return Math.max(head, body);
}

function compareScored(a: Scored, b: Scored): number {
  return (
    b.combined - a.combined ||
    Number(b.item.macro.isFavorite) - Number(a.item.macro.isFavorite) ||
    b.item.macro.useCount - a.item.macro.useCount ||
    a.item.macro.title.localeCompare(b.item.macro.title)
  );
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Score every candidate; candidates without any signal (no text, meaning or intent match) are dropped. */
function scoreCandidates(input: RankInput, weights: ReadonlyMap<Intent, number>): Scored[] {
  const { entries, provider, queryVector, lexicalHits } = input;
  const candidates = new Set<Id>(lexicalHits.slice(0, CANDIDATES_PER_SOURCE).map((h) => h.id));
  const semantic = new Map<Id, number>();
  const intents = new Map<Id, IntentMatch>();
  let maxUseCount = 0;

  for (const [id, item] of entries) {
    if (item.macro.useCount > maxUseCount) maxUseCount = item.macro.useCount;
    if (queryVector) semantic.set(id, calibrateSemantic(provider, rawSemantic(queryVector, item)));
    const match = matchIntents(item.macro.intents, weights);
    if (match.score > 0) {
      intents.set(id, match);
      candidates.add(id);
    }
  }
  const bySemantic = [...semantic].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  for (const [id] of bySemantic.slice(0, CANDIDATES_PER_SOURCE)) candidates.add(id);

  const bm25 = new Map(lexicalHits.map((h) => [h.id, h.score]));
  const maxBm25 = lexicalHits[0]?.score ?? 0;
  const scored: Scored[] = [];
  for (const id of candidates) {
    const item = entries.get(id);
    if (!item) continue;
    const intent = intents.get(id) ?? { score: 0, relatedTo: null };
    const breakdown: ScoreBreakdown = {
      semantic: semantic.get(id) ?? 0,
      lexical: lexicalScore(bm25.get(id) ?? 0, maxBm25),
      intent: intent.score,
      usage: usageScore(item.macro.useCount, maxUseCount, item.macro.isFavorite),
    };
    if (breakdown.semantic === 0 && breakdown.lexical === 0 && breakdown.intent === 0) continue;
    const combined = combineScores(breakdown, queryVector !== null);
    scored.push({ item, breakdown, combined, confidence: confidenceOf(combined), intent });
  }
  return scored.sort(compareScored);
}

/**
 * Keep the best macro first; for multi-question messages promote the best macro of each uncovered secondary
 * intent to the next slots (when confident enough), then fill up with the remaining ranking.
 */
function diversify(ranked: Scored[], analysis: Analysis, wanted: Intent[], maxResults: number): Scored[] {
  const top = ranked[0];
  if (!top || maxResults < 2 || !isMultiTopic(analysis)) return ranked.slice(0, maxResults);
  const picked: Scored[] = [top];
  const covered = new Set<Intent>(top.item.macro.intents);
  for (const intent of wanted) {
    if (picked.length >= maxResults) break;
    if (covered.has(intent)) continue;
    const best = ranked.find((s) => !picked.includes(s) && s.item.macro.intents.includes(intent));
    if (!best || best.confidence < MIN_DIVERSIFY_CONFIDENCE) continue;
    picked.push(best);
    for (const i of best.item.macro.intents) covered.add(i);
  }
  for (const s of ranked) {
    if (picked.length >= maxResults) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked;
}

/**
 * Query terms found in the macro, in message order: lexical matches plus the customer's words for concepts the
 * macro shares ("cashout" for a withdrawal macro), then matched expansion terms. Max 6, display form.
 */
function matchedTermsOf(item: IndexedMacro, hit: LexicalHit | undefined, query: LexicalQuery): string[] {
  const lexical = new Set(hit?.queryTerms ?? []);
  const conceptWords = new Set<string>();
  for (const [id, words] of query.concepts) {
    if (!UNEXPLAINING_CONCEPTS.has(id) && item.concepts.has(id)) for (const w of words) conceptWords.add(w);
  }
  const out = new Set<string>();
  const add = (word: string): void => {
    if (out.size < MAX_MATCHED_TERMS) out.add(displayTerm(word));
  };
  for (const term of query.terms) {
    if (query.expansions.has(term)) continue;
    // Show the corrected spelling of a typo that matched ("withdrawl" -> "withdrawal").
    const correction = query.corrections.get(term);
    if (correction && (lexical.has(term) || lexical.has(correction))) {
      add(query.display.get(correction) ?? correction);
      continue;
    }
    const word = query.display.get(term) ?? term;
    if (lexical.has(term) || conceptWords.has(word)) add(word);
  }
  for (const word of conceptWords) add(word);
  for (const term of query.terms) if (query.expansions.has(term) && lexical.has(term)) add(query.display.get(term) ?? term);
  return [...out];
}

function toRecommendation(s: Scored, input: RankInput, asked: ReadonlySet<Intent>, hit: LexicalHit | undefined): Recommendation {
  const { macro } = s.item;
  const coversIntents = macro.intents.filter((i) => asked.has(i));
  const matchedTerms = matchedTermsOf(s.item, hit, input.query);
  const breakdown: ScoreBreakdown = {
    semantic: round3(s.breakdown.semantic),
    lexical: round3(s.breakdown.lexical),
    intent: round3(s.breakdown.intent),
    usage: round3(s.breakdown.usage),
  };
  return {
    macroId: macro.id,
    title: macro.title,
    categoryId: macro.categoryId,
    confidence: s.confidence,
    reason: buildReason({
      coversIntents: coversIntents.filter((i) => i !== 'general'),
      relatedIntent: s.intent.relatedTo,
      matchedTerms,
      breakdown,
      verification: macro.verification,
      hasFacts: macro.facts.length > 0,
    }),
    matchedTerms,
    coversIntents,
    verification: macro.verification,
    warnings: verificationWarnings(macro.facts),
    breakdown,
  };
}

/** Rank macros for a message. See MacroIndex.search for the contract. */
export function rankMacros(input: RankInput): RankResult {
  const { analysis } = input;
  const weights = intentWeights(analysis);
  const wanted = wantedIntents(analysis, weights);
  const maxResults = Math.max(1, Math.floor(input.maxResults));
  const picked = diversify(scoreCandidates(input, weights), analysis, wanted, maxResults);

  const asked = new Set<Intent>(analysis.intents.map((i) => i.intent));
  for (const q of analysis.questions) if (q.intent) asked.add(q.intent);
  const hits = new Map(input.lexicalHits.map((h) => [h.id, h]));
  const recommendations = picked.map((s) => toRecommendation(s, input, asked, hits.get(s.item.macro.id)));

  const covered = new Set(picked.flatMap((s) => s.item.macro.intents));
  return {
    recommendations,
    noGoodMatch: (recommendations[0]?.confidence ?? 0) < input.minConfidence,
    uncoveredIntents: wanted.filter((i) => !covered.has(i)),
  };
}
