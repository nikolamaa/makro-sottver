/**
 * Lexical query construction: message terms (stemmed, stopwords removed) plus low-boost expansion terms from
 * the iGaming concept vocabulary ("cashout" -> withdrawal) and from typo corrections ("withdrawl" -> withdrawal).
 */
import { CONCEPTS, conceptsOfTerm } from '../domain/igaming.js';
import { correctTypo, matchConcepts } from './concepts.js';
import { isNoiseToken, stem, tokenize } from './text.js';

const MAX_MESSAGE_TERMS = 32;
const MAX_EXPANSION_TERMS = 16;
/** Concepts present in nearly every conversation; expanding them only adds noise. */
const NON_EXPANDING_CONCEPTS: ReadonlySet<string> = new Set(['time', 'account', 'complaint']);

/** Canonical expansion words per concept: words of the concept id plus words of its first (canonical) term. */
const CONCEPT_EXPANSIONS: ReadonlyMap<string, string[]> = new Map(
  CONCEPTS.map((g) => {
    const words = tokenize(`${g.id.replace(/_/g, ' ')} ${g.terms[0] ?? ''}`).filter((w) => !isNoiseToken(w));
    return [g.id, [...new Set(words)]];
  }),
);

export interface LexicalQuery {
  /** Processed terms: message terms first, then expansions. Unique. */
  terms: string[];
  /** Processed terms that come from expansion (searched with a lower boost). */
  expansions: ReadonlySet<string>;
  /** Processed term -> display form (the customer's word, or the canonical expansion word). */
  display: ReadonlyMap<string, string>;
  /** Concept ids in the message (including typo-corrected words) -> the customer's words for them. */
  concepts: ReadonlyMap<string, string[]>;
}

/** Build the lexical query for a customer message. Pure and fast (< 1 ms for typical messages). */
export function buildLexicalQuery(message: string): LexicalQuery {
  const display = new Map<string, string>();
  const terms: string[] = [];
  const concepts = matchConcepts(message);
  const corrected: string[] = [];

  for (const token of tokenize(message)) {
    if (isNoiseToken(token)) continue;
    const term = stem(token);
    const fixed = correctTypo(token);
    if (!display.has(term) && terms.length < MAX_MESSAGE_TERMS) {
      // A misspelled word is displayed with its corrected spelling ("withdrawl" -> "withdrawal").
      display.set(term, fixed ?? token);
      terms.push(term);
    }
    if (!fixed) continue;
    corrected.push(fixed);
    for (const id of conceptsOfTerm(fixed)) {
      const words = concepts.get(id);
      if (!words) concepts.set(id, [fixed]);
      else if (!words.includes(fixed)) words.push(fixed);
    }
  }

  const expansions = new Set<string>();
  const addExpansion = (word: string): void => {
    const term = stem(word);
    if (display.has(term) || expansions.size >= MAX_EXPANSION_TERMS) return;
    display.set(term, word);
    expansions.add(term);
    terms.push(term);
  };
  for (const word of corrected) addExpansion(word);
  for (const id of concepts.keys()) {
    if (NON_EXPANDING_CONCEPTS.has(id)) continue;
    for (const word of CONCEPT_EXPANSIONS.get(id) ?? []) addExpansion(word);
  }
  return { terms, expansions, display, concepts };
}
