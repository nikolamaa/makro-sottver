/**
 * Lexical side of the hybrid index: MiniSearch (BM25+) over macro fields with prefix/fuzzy matching.
 * Indexing stores stems plus surface forms (see text.ts); queries arrive pre-processed from query.ts.
 */
import MiniSearch from 'minisearch';
import { INTENT_LABELS, type Id, type Macro } from '../../shared/types.js';
import type { LexicalQuery } from './query.js';
import { indexTermForms, stripTemplateVariables, tokenize } from './text.js';

export const FIELD_BOOST = { title: 3, triggers: 2.5, shortcut: 2, tags: 1.5, intentText: 1.5, body: 1 } as const;
/** Boost of expansion terms (synonyms/typo corrections) relative to the customer's own words. */
export const EXPANSION_BOOST = 0.5;

export interface IndexDoc {
  id: Id;
  title: string;
  triggers: string;
  shortcut: string;
  tags: string;
  /** Intent labels and ids, e.g. "Pending withdrawal withdrawal_pending". */
  intentText: string;
  /** Body with {{variables}} removed. */
  body: string;
}

export type LexicalIndex = MiniSearch<IndexDoc>;

export interface LexicalHit {
  id: Id;
  /** MiniSearch BM25 score (unbounded). */
  score: number;
  /** Processed query terms that matched this macro. */
  queryTerms: string[];
}

export function toIndexDoc(m: Macro): IndexDoc {
  return {
    id: m.id,
    title: m.title,
    triggers: m.triggers.join('\n'),
    shortcut: m.shortcut,
    tags: m.tags.join(' '),
    intentText: m.intents.map((i) => `${INTENT_LABELS[i]} ${i}`).join(' '),
    body: stripTemplateVariables(m.body),
  };
}

export function createLexicalIndex(macros: Macro[]): LexicalIndex {
  const index = new MiniSearch<IndexDoc>({
    fields: Object.keys(FIELD_BOOST),
    storeFields: [],
    tokenize: (text) => tokenize(text),
    processTerm: (term) => indexTermForms(term),
  });
  index.addAll(macros.map(toIndexDoc));
  return index;
}

/** BM25 hits for a query, best first. Prefix search for terms >= 4 chars, fuzzy (0.2) for terms >= 5 chars. */
export function searchLexical(index: LexicalIndex, query: LexicalQuery): LexicalHit[] {
  if (query.terms.length === 0 || index.documentCount === 0) return [];
  const results = index.search(query.terms.join(' '), {
    tokenize: (q) => q.split(' '),
    processTerm: (t) => t,
    boost: FIELD_BOOST,
    prefix: (t) => t.length >= 4,
    fuzzy: (t) => (t.length >= 5 ? 0.2 : false),
    maxFuzzy: 2,
    combineWith: 'OR',
    boostTerm: (t) => (query.expansions.has(t) ? EXPANSION_BOOST : 1),
  });
  return results.map((r) => ({ id: r.id as Id, score: r.score, queryTerms: r.queryTerms }));
}
