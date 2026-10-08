/**
 * Hybrid ranking of indexed macros for one customer message: candidate selection, score components,
 * relevance adjustments (concept coverage, product mismatch, resolved money flows), calibrated confidence,
 * multi-question diversification and explanations. Pure and synchronous; the MacroIndex supplies the lexical
 * hits, the query vector and the message signals.
 */
import type { Analysis, EmbedderStatus, Id, Intent, Macro, Recommendation, ScoreBreakdown } from '../../shared/types.js';
import { verificationWarnings } from '../../shared/verification.js';
import type { Product } from '../domain/igaming.js';
import { cosine } from './embedder.js';
import { buildReason, displayTerm, type ReasonCaveat } from './explain.js';
import type { LexicalHit } from './lexical.js';
import type { LexicalQuery } from './query.js';
import {
  BODY_FACTOR,
  calibrateSemantic,
  combineScores,
  confidenceOf,
  idf,
  intentWeights,
  isMultiTopic,
  lexicalScore,
  matchIntents,
  RELATED_INTENTS,
  relevanceFactor,
  usageScore,
  wantedIntents,
  type IntentMatch,
} from './scoring.js';
import {
  conceptCoverage,
  GENERIC_CONCEPTS,
  MODIFIER_CONCEPT_WEIGHT,
  MODIFIER_CONCEPTS,
  isProductMismatch,
  RESOLVED_FLOW_INTENT,
  type MessageSignals,
  type QuestionFocus,
} from './signals.js';
import { isGenericWord, isNoiseToken, stem, tokenize } from './text.js';

/** A macro as held by the index: decrypted content, passage vectors and its relevance features. */
export interface IndexedMacro {
  macro: Macro;
  head: Float32Array | null;
  body: Float32Array | null;
  /** Concepts the macro mentions anywhere (head, body, template variable names). */
  concepts: ReadonlySet<string>;
  /** Concepts of the head passage (title, triggers, intent labels, tags): what the macro is about. */
  headConcepts: ReadonlySet<string>;
  /** Products the macro is specific to; empty when it applies to any product. */
  products: ReadonlySet<Product>;
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
  /** Question focus, products and resolved money flows of the message (see signals.ts). */
  signals: MessageSignals;
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
const DEFAULT_MAX_RESULTS = 3;
/** Below this concept coverage the reason names what the macro does not cover. */
const COVERAGE_CAVEAT_BELOW = 0.7;
/** A term found in more than this share of the library explains nothing ("account" in a library that says it everywhere). */
const MAX_EXPLAINING_DF_SHARE = 0.6;
/** ...but only judge that on libraries large enough for document frequencies to mean something. */
const MIN_LIBRARY_FOR_DF = 20;

interface Scored {
  item: IndexedMacro;
  breakdown: ScoreBreakdown;
  /** Combined score after the relevance adjustments; ranks and calibrates confidence. */
  combined: number;
  confidence: number;
  intent: IntentMatch;
  coverage: number;
  productMismatch: boolean;
  resolvedConflict: boolean;
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

/** Intents contradicted by money flows the customer reports as resolved ("deposit arrived" -> deposit_missing). */
function suppressedIntents(signals: MessageSignals): Set<Intent> {
  return new Set([...signals.resolved].map((flow) => RESOLVED_FLOW_INTENT[flow]));
}

/** Concept -> inverse document frequency over the library (rare concepts identify a question better). */
function conceptWeights(entries: ReadonlyMap<Id, IndexedMacro>): (concept: string) => number {
  const df = new Map<string, number>();
  for (const item of entries.values()) for (const c of item.concepts) df.set(c, (df.get(c) ?? 0) + 1);
  const n = entries.size;
  const cache = new Map<string, number>();
  return (concept) => {
    let w = cache.get(concept);
    if (w === undefined) {
      w = idf(df.get(concept) ?? 0, n) * (MODIFIER_CONCEPTS.has(concept) ? MODIFIER_CONCEPT_WEIGHT : 1);
      cache.set(concept, w);
    }
    return w;
  };
}

/**
 * Candidates = top-40 lexical hits + top-40 semantic hits + every macro whose intents match the analysis (so the
 * best macro for a secondary question is always considered). Candidates without any signal are dropped.
 */
function scoreCandidates(input: RankInput, weights: ReadonlyMap<Intent, number>, suppressed: ReadonlySet<Intent>): Scored[] {
  const { entries, provider, queryVector, lexicalHits, signals } = input;
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

  const conceptWeight = conceptWeights(entries);
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
    const coverage = conceptCoverage(signals.questions, item.concepts, conceptWeight);
    const productMismatch = isProductMismatch(signals.products, item.products);
    const resolvedConflict = item.macro.intents.some((i) => suppressed.has(i));
    const combined = combineScores(breakdown, queryVector !== null) * relevanceFactor({ coverage, productMismatch, resolvedConflict });
    scored.push({ item, breakdown, combined, confidence: confidenceOf(combined), intent, coverage, productMismatch, resolvedConflict });
  }
  scored.sort(compareScored);
  if (process.env.DEBUG_RANK) {
    console.log('  signals', JSON.stringify({ q: signals.questions.map((q) => [...q.concepts]), p: [...signals.products], r: [...signals.resolved] }));
    for (const s of scored.slice(0, 4)) console.log(`   ${s.confidence} ${s.item.macro.title.slice(0, 50)} cov=${s.coverage.toFixed(2)} pm=${s.productMismatch} rc=${s.resolvedConflict} concepts=${[...s.item.concepts].join(',')} prod=${[...s.item.products].join(',')}`);
  }
  return scored;
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
 * The question span a macro answers in a multi-question message: span intent among the macro's intents, plus the
 * share of the span's concepts the macro mentions, plus the share of its terms the macro matched. Null for
 * single-question messages.
 */
function answeredQuestion(item: IndexedMacro, signals: MessageSignals, lexical: ReadonlySet<string>): QuestionFocus | null {
  const spans = signals.questions.slice(1);
  if (spans.length < 2) return null;
  let best: QuestionFocus | null = null;
  let bestScore = -1;
  for (const q of spans) {
    let score = q.intent && item.macro.intents.includes(q.intent) ? 1 : 0;
    if (q.concepts.size) score += [...q.concepts].filter((c) => item.concepts.has(c)).length / q.concepts.size;
    if (q.terms.size) score += [...q.terms].filter((t) => lexical.has(t)).length / q.terms.size;
    if (score > bestScore) {
      best = q;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Terms that must not explain this macro: words of the other questions of a multi-question message (they support
 * other macros) and words that only occur in resolved clauses ("deposit arrived").
 */
function foreignTerms(item: IndexedMacro, signals: MessageSignals, lexical: ReadonlySet<string>): Set<string> {
  const out = new Set(signals.resolvedTerms);
  const own = answeredQuestion(item, signals, lexical);
  if (!own) return out;
  for (const q of signals.questions.slice(1)) {
    if (q === own) continue;
    for (const t of q.terms) if (!own.terms.has(t)) out.add(t);
  }
  return out;
}

/** True when a (possibly multi-word) customer phrase has a content word and none of its words is foreign. */
function phraseExplains(phrase: string, foreign: ReadonlySet<string>): boolean {
  let content = false;
  for (const token of tokenize(phrase)) {
    if (foreign.has(stem(token))) return false;
    if (!isNoiseToken(token) && !isGenericWord(token)) content = true;
  }
  return content;
}

/**
 * Query terms that explain the match, in message order: the customer's words the macro contains (lexical matches)
 * plus their words for concepts the macro is about (its head concepts: "cashout" for a withdrawal macro), then
 * matched expansion terms. Only words of the question this macro answers; never stopwords, generic words
 * ("going", "take") or words found in most of the library. Max 6, display form.
 */
function matchedTermsOf(item: IndexedMacro, hit: LexicalHit | undefined, input: RankInput, termDf: ReadonlyMap<string, number>): string[] {
  const { query, signals, entries } = input;
  const lexical = new Set(hit?.queryTerms ?? []);
  const foreign = foreignTerms(item, signals, lexical);
  const tooCommon = (term: string): boolean =>
    entries.size >= MIN_LIBRARY_FOR_DF && (termDf.get(term) ?? 0) > MAX_EXPLAINING_DF_SHARE * entries.size;
  const explains = (term: string, word: string): boolean => !foreign.has(term) && !tooCommon(term) && phraseExplains(word, foreign);

  const conceptWords = new Set<string>();
  for (const [id, words] of query.concepts) {
    if (GENERIC_CONCEPTS.has(id) || !item.headConcepts.has(id)) continue;
    for (const w of words) if (phraseExplains(w, foreign)) conceptWords.add(w);
  }
  const out = new Set<string>();
  const add = (word: string): void => {
    if (out.size < MAX_MATCHED_TERMS) out.add(displayTerm(word));
  };
  for (const term of query.terms) {
    const word = query.display.get(term) ?? term;
    if (query.expansions.has(term)) continue;
    if ((lexical.has(term) && explains(term, word)) || conceptWords.has(word)) add(word);
  }
  for (const word of conceptWords) add(word);
  for (const term of query.terms) {
    const word = query.display.get(term) ?? term;
    if (query.expansions.has(term) && lexical.has(term) && explains(term, word)) add(word);
  }
  return [...out];
}

/** Customer's words for the concepts of the best question that the macro does not mention. */
function uncoveredWords(item: IndexedMacro, input: RankInput): string[] {
  const words: string[] = [];
  for (const [id, said] of input.query.concepts) {
    if (GENERIC_CONCEPTS.has(id) || item.concepts.has(id) || !input.signals.questions[0]?.concepts.has(id)) continue;
    const word = said[0];
    if (word && !isGenericWord(word)) words.push(word);
  }
  return words;
}

function caveatOf(s: Scored, input: RankInput): ReasonCaveat | null {
  if (s.resolvedConflict) {
    const flow = [...input.signals.resolved].find((f) => s.item.macro.intents.includes(RESOLVED_FLOW_INTENT[f]));
    if (flow) return { kind: 'resolved', flow };
  }
  if (s.productMismatch) return { kind: 'product', asked: [...input.signals.products], macro: [...s.item.products] };
  if (s.coverage < COVERAGE_CAVEAT_BELOW) {
    const words = uncoveredWords(s.item, input);
    if (words.length) return { kind: 'uncovered', words };
  }
  return null;
}

function toRecommendation(
  s: Scored,
  input: RankInput,
  asked: ReadonlySet<Intent>,
  hit: LexicalHit | undefined,
  termDf: ReadonlyMap<string, number>,
): Recommendation {
  const { macro } = s.item;
  const coversIntents = macro.intents.filter((i) => asked.has(i));
  const matchedTerms = matchedTermsOf(s.item, hit, input, termDf);
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
      caveat: caveatOf(s, input),
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
  const suppressed = suppressedIntents(input.signals);
  const weights = intentWeights(analysis);
  for (const i of suppressed) weights.delete(i);
  const wanted = wantedIntents(analysis, weights).filter((i) => !suppressed.has(i));
  const maxResults = Number.isFinite(input.maxResults) ? Math.max(1, Math.floor(input.maxResults)) : DEFAULT_MAX_RESULTS;
  const picked = diversify(scoreCandidates(input, weights, suppressed), analysis, wanted, maxResults);

  const asked = new Set<Intent>(analysis.intents.map((i) => i.intent));
  for (const q of analysis.questions) if (q.intent) asked.add(q.intent);
  for (const i of suppressed) asked.delete(i);
  const hits = new Map(input.lexicalHits.map((h) => [h.id, h]));
  const termDf = new Map<string, number>();
  for (const h of input.lexicalHits) for (const t of h.queryTerms) termDf.set(t, (termDf.get(t) ?? 0) + 1);
  const recommendations = picked.map((s) => toRecommendation(s, input, asked, hits.get(s.item.macro.id), termDf));

  return {
    recommendations,
    noGoodMatch: (recommendations[0]?.confidence ?? 0) < input.minConfidence,
    uncoveredIntents: uncoveredIntents(picked, wanted, analysis),
  };
}

/**
 * Wanted intents no returned macro covers. An explicit question needs a macro with exactly that intent; an
 * intent only scored by the analyzer (no question of its own) also counts as covered by a related intent,
 * so "withdrawal help" is not reported when a pending-withdrawal macro is returned.
 */
function uncoveredIntents(picked: Scored[], wanted: Intent[], analysis: Analysis): Intent[] {
  const covered = new Set(picked.flatMap((s) => s.item.macro.intents));
  const related = new Set([...covered].flatMap((i) => [...(RELATED_INTENTS.get(i) ?? [])]));
  const asked = new Set(analysis.questions.flatMap((q) => (q.intent ? [q.intent] : [])));
  return wanted.filter((i) => !covered.has(i) && (asked.has(i) || !related.has(i)));
}
