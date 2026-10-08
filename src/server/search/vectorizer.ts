/**
 * Builtin "embedding": a deterministic feature-hashing vectorizer tuned for iGaming support text.
 *
 * Features (hashed into BUILTIN_DIM buckets with a sign bit, then L2-normalized):
 *  - concept ids from the domain vocabulary (high weight): "cashout" and "withdrawal" share the feature
 *    `withdrawal`, which is what makes this behave semantically rather than lexically;
 *  - concepts of misspelled domain words ("withdrawl" -> withdrawal) at a reduced weight;
 *  - lightly stemmed content words (stopwords removed), sub-linear term frequency;
 *  - boundary-padded character trigrams of content words (low weight) for robustness to unseen typos.
 */
import { conceptsOfTerm } from '../domain/igaming.js';
import { correctTypo, matchConcepts } from './concepts.js';
import { isNoiseToken, stem, tokenize } from './text.js';

export const BUILTIN_DIM = 768;
export const BUILTIN_MODEL = 'builtin-v1';

const CONCEPT_WEIGHT = 2.5;
/** Concepts that appear in almost every support conversation ("today", "account") carry little signal. */
const GENERIC_CONCEPTS: ReadonlySet<string> = new Set(['time', 'account']);
const GENERIC_CONCEPT_WEIGHT = 0.8;
/** Weight factor for features derived from a typo correction. */
const TYPO_FACTOR = 0.7;
const WORD_WEIGHT = 1;
const TRIGRAM_WEIGHT = 0.25;

const SEED_CONCEPT = 0x811c9dc5;
const SEED_WORD = 0x9e3779b9;
const SEED_TRIGRAM = 0x85ebca6b;
const FNV_PRIME = 0x01000193;
const CHAR_START = 0x02;
const CHAR_END = 0x03;

/** FNV-1a over a string, starting from a namespace seed. */
function fnv1a(seed: number, s: string): number {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h;
}

/** Murmur3 finalizer: spreads FNV's weak low bits so bucket and sign bit are independent. */
function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function addFeature(v: Float32Array, hash: number, weight: number): void {
  const h = mix(hash);
  v[(h >>> 1) % BUILTIN_DIM]! += h & 1 ? weight : -weight;
}

function addTrigrams(v: Float32Array, word: string): void {
  const n = word.length;
  // Padded with start/end markers: "<ab>" style, without allocating substrings.
  for (let i = -1; i <= n - 2; i++) {
    const a = i < 0 ? CHAR_START : word.charCodeAt(i);
    const b = word.charCodeAt(i + 1);
    const c = i + 2 < n ? word.charCodeAt(i + 2) : CHAR_END;
    let h = SEED_TRIGRAM;
    h = Math.imul(h ^ a, FNV_PRIME);
    h = Math.imul(h ^ b, FNV_PRIME);
    h = Math.imul(h ^ c, FNV_PRIME);
    addFeature(v, h, TRIGRAM_WEIGHT);
  }
}

function conceptWeight(id: string): number {
  return GENERIC_CONCEPTS.has(id) ? GENERIC_CONCEPT_WEIGHT : CONCEPT_WEIGHT;
}

function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  if (sum === 0) return v;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i]! *= inv;
  return v;
}

/** Deterministic L2-normalized vector of length BUILTIN_DIM (all zeros for text without content words). */
export function vectorize(text: string): Float32Array {
  const v = new Float32Array(BUILTIN_DIM);
  const concepts = matchConcepts(text);
  for (const id of concepts.keys()) addFeature(v, fnv1a(SEED_CONCEPT, id), conceptWeight(id));

  const wordCounts = new Map<string, number>();
  const typoConcepts = new Set<string>();
  for (const token of tokenize(text)) {
    if (isNoiseToken(token)) continue;
    const s = stem(token);
    wordCounts.set(s, (wordCounts.get(s) ?? 0) + 1);
    addTrigrams(v, token);
    const fixed = correctTypo(token);
    if (!fixed) continue;
    const fixedStem = stem(fixed);
    wordCounts.set(fixedStem, (wordCounts.get(fixedStem) ?? 0) + TYPO_FACTOR);
    for (const id of conceptsOfTerm(fixed)) if (!concepts.has(id)) typoConcepts.add(id);
  }
  for (const id of typoConcepts) addFeature(v, fnv1a(SEED_CONCEPT, id), conceptWeight(id) * TYPO_FACTOR);
  for (const [word, count] of wordCounts) {
    addFeature(v, fnv1a(SEED_WORD, word), WORD_WEIGHT * (count <= 1 ? count : 1 + Math.log(count)));
  }
  return l2Normalize(v);
}
