/**
 * Longest-match concept scanner over the iGaming vocabulary (CONCEPTS in ../domain/igaming.ts).
 *
 * Same vocabulary and word-boundary semantics as findConcepts(), but non-overlapping: at each position the
 * longest known phrase wins, so "id card" counts as KYC (not as the payment word "card"), "deposit limit" as
 * responsible gambling (not deposit + limit) and "max bet" as betting limits. It is also token based, so a
 * 1,000-character message is scanned in tens of microseconds.
 */
import { CONCEPTS, normalizeForMatch } from '../domain/igaming.js';

/** Concept mentions found in a message. */
export interface ConceptHits {
  /** concept id -> unique matched terms (canonical spelling from CONCEPTS), in order of appearance. */
  readonly byConcept: ReadonlyMap<string, readonly string[]>;
  /** Unique matched terms in order of appearance. */
  readonly terms: readonly string[];
}

/** A message prepared once and shared by the analyzer steps. */
export interface Prepared {
  readonly raw: string;
  /** Lowercase, whitespace-collapsed, quotes normalized (see normalizeForMatch). */
  readonly norm: string;
  readonly concepts: ConceptHits;
}

interface TermEntry {
  term: string;
  ids: string[];
}

const TOKEN_RE = /[a-z0-9]+/g;

function tokenKey(phrase: string): string {
  return (phrase.toLowerCase().match(TOKEN_RE) ?? []).join(' ');
}

/** Plural fallback ("referrals" -> "referral") only for longer words, so "mins"/"caps" never match "min"/"cap". */
const MIN_PLURAL_LENGTH = 5;

const TERM_INDEX = new Map<string, TermEntry>();
const PREFIXES = new Set<string>();
let MAX_TOKENS = 1;

for (const group of CONCEPTS) {
  for (const term of group.terms) {
    const key = tokenKey(term);
    if (!key) continue;
    const entry = TERM_INDEX.get(key);
    if (entry) {
      if (!entry.ids.includes(group.id)) entry.ids.push(group.id);
    } else {
      TERM_INDEX.set(key, { term, ids: [group.id] });
    }
    const parts = key.split(' ');
    MAX_TOKENS = Math.max(MAX_TOKENS, parts.length);
    for (let n = 1; n < parts.length; n++) PREFIXES.add(parts.slice(0, n).join(' '));
  }
}

/** Find concept mentions in already-normalized text (longest match wins, no overlaps). */
export function scanConcepts(norm: string): ConceptHits {
  const tokens = norm.match(TOKEN_RE) ?? [];
  const byConcept = new Map<string, string[]>();
  const terms: string[] = [];
  const seenTerms = new Set<string>();
  let i = 0;
  while (i < tokens.length) {
    let key = tokens[i] ?? '';
    let best = singularFallback(key);
    let bestLen = best ? 1 : 0;
    for (let n = 1; ; n++) {
      const hit = TERM_INDEX.get(key);
      if (hit) {
        best = hit;
        bestLen = n;
      }
      if (n >= MAX_TOKENS || i + n >= tokens.length || !PREFIXES.has(key)) break;
      key += ` ${tokens[i + n] ?? ''}`;
    }
    if (best) {
      record(best, byConcept, terms, seenTerms);
      i += bestLen;
    } else {
      i++;
    }
  }
  return { byConcept, terms };
}

/** Single-token match of a regular plural whose singular is a known term. */
function singularFallback(token: string): TermEntry | undefined {
  if (token.length < MIN_PLURAL_LENGTH || !token.endsWith('s') || TERM_INDEX.has(token)) return undefined;
  return TERM_INDEX.get(token.slice(0, -1));
}

function record(entry: TermEntry, byConcept: Map<string, string[]>, terms: string[], seen: Set<string>): void {
  if (seen.has(entry.term)) return;
  seen.add(entry.term);
  terms.push(entry.term);
  for (const id of entry.ids) {
    const list = byConcept.get(id);
    if (list) list.push(entry.term);
    else byConcept.set(id, [entry.term]);
  }
}

/** Normalize a message and scan its concepts once. */
export function prepare(raw: string): Prepared {
  const norm = normalizeForMatch(raw);
  return { raw, norm, concepts: scanConcepts(norm) };
}

/** True when the concept was mentioned. */
export function has(p: Prepared, conceptId: string): boolean {
  return p.concepts.byConcept.has(conceptId);
}

/** Matched terms of a concept (empty when not mentioned). */
export function termsOf(p: Prepared, conceptId: string): readonly string[] {
  return p.concepts.byConcept.get(conceptId) ?? [];
}

/**
 * Evidence weight of a concept: the strongest matched term's weight (default `strong`, overridable per term)
 * plus 0.25 for every additional distinct term, capped at +0.75.
 */
export function conceptWeight(p: Prepared, conceptId: string, strong: number, perTerm: Readonly<Record<string, number>> = {}): number {
  const terms = termsOf(p, conceptId);
  let max = 0;
  let counted = 0;
  for (const t of terms) {
    const w = perTerm[t] ?? strong;
    if (w <= 0) continue;
    counted++;
    if (w > max) max = w;
  }
  return counted ? max + Math.min(0.75, 0.25 * (counted - 1)) : 0;
}
