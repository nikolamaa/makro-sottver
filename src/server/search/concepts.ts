/**
 * Fast concept detection for the search layer.
 *
 * `matchConcepts` returns exactly what `findConcepts()` from domain/igaming.ts returns, but scans the text once
 * with a character trie instead of testing ~500 regexes, which keeps re-indexing thousands of macros fast.
 * `correctTypo` maps a misspelled domain word ("withdrawl", "pendng") to the concept term it most likely means.
 */
import { CONCEPTS, normalizeForMatch } from '../domain/igaming.js';

interface TrieNode {
  next: Map<number, TrieNode>;
  /** Indexes into TERMS of the concept terms ending at this node. */
  ends: number[];
}

interface ConceptTerm {
  id: string;
  term: string;
}

/** Every (concept, term) pair in CONCEPTS order, which is also findConcepts' output order. */
const TERMS: ConceptTerm[] = CONCEPTS.flatMap((g) => g.terms.map((term) => ({ id: g.id, term })));

function buildTrie(): TrieNode {
  const root: TrieNode = { next: new Map(), ends: [] };
  TERMS.forEach(({ term }, index) => {
    let node = root;
    for (let i = 0; i < term.length; i++) {
      const code = term.charCodeAt(i);
      let child = node.next.get(code);
      if (!child) {
        child = { next: new Map(), ends: [] };
        node.next.set(code, child);
      }
      node = child;
    }
    node.ends.push(index);
  });
  return root;
}

const TRIE = buildTrie();

/** Mirrors the `[a-z0-9]` word boundary used by findConcepts (text is already lowercased). */
function isWordChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
}

function collectMatches(norm: string): number[] {
  const hits = new Set<number>();
  const n = norm.length;
  for (let start = 0; start < n; start++) {
    if (start > 0 && isWordChar(norm.charCodeAt(start - 1))) continue;
    let node: TrieNode | undefined = TRIE;
    for (let j = start; j < n && node; j++) {
      node = node.next.get(norm.charCodeAt(j));
      if (node && node.ends.length && (j + 1 === n || !isWordChar(norm.charCodeAt(j + 1)))) {
        for (const e of node.ends) hits.add(e);
      }
    }
  }
  return [...hits].sort((a, b) => a - b);
}

/**
 * Concept ids mentioned in a text with the matched terms; same result (including order) as findConcepts().
 * Example: "my btc cashout is stuck" -> { withdrawal: ['cashout'], pending: ['stuck'], crypto: ['btc'] }
 */
export function matchConcepts(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const index of collectMatches(normalizeForMatch(text))) {
    const t = TERMS[index];
    if (!t) continue;
    const list = out.get(t.id);
    if (list) list.push(t.term);
    else out.set(t.id, [t.term]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typo correction against single-word concept terms
// ---------------------------------------------------------------------------

const MIN_TYPO_TOKEN = 5;
const MIN_VOCAB_TERM = 5;
/** An extra letter is only assumed on words of >= 6 letters (5-letter words would map to 4-letter terms). */
const MIN_EXTRA_LETTER_TOKEN = 6;
/** Substitutions ("withdrawel") are only trusted on long words; short ones collide with real words. */
const MIN_SUBSTITUTION_TOKEN = 8;
/** Real English words one edit away from a domain term ("layer" ~ "lawyer"); never corrected. */
const REAL_WORDS: ReadonlySet<string> = new Set(['spots', 'total', 'layer', 'broke']);
const ALPHA_RE = /^[a-z]+$/;

const VOCAB: ReadonlySet<string> = new Set(TERMS.map((t) => t.term).filter((t) => t.length >= MIN_VOCAB_TERM && ALPHA_RE.test(t)));
/**
 * Longest token that can be one edit away from a vocabulary term (the longest term + one extra letter). Longer
 * tokens (keyboard mash, words run together) are never corrected, which also keeps the work per token bounded:
 * findCorrection builds ~2n strings of length n, so an 8000-letter token would otherwise cost ~200 ms.
 */
const MAX_TYPO_TOKEN = Math.max(0, ...[...VOCAB].map((t) => t.length)) + 1;

/** One-deletion variants (never deleting the first letter) -> vocabulary term; null marks ambiguous variants. */
const DELETES: ReadonlyMap<string, string | null> = (() => {
  const map = new Map<string, string | null>();
  for (const term of VOCAB) {
    for (let i = 1; i < term.length; i++) {
      const variant = term.slice(0, i) + term.slice(i + 1);
      if (VOCAB.has(variant)) continue;
      const prev = map.get(variant);
      map.set(variant, prev === undefined || prev === term ? term : null);
    }
  }
  return map;
})();

function findCorrection(token: string): string | null {
  // Missing letter: "withdrawl" -> "withdrawal".
  const missing = DELETES.get(token);
  if (missing) return missing;
  const n = token.length;
  for (let i = 1; i < n; i++) {
    const shorter = token.slice(0, i) + token.slice(i + 1);
    // Extra letter: "deposite" -> "deposit".
    if (n >= MIN_EXTRA_LETTER_TOKEN && VOCAB.has(shorter)) return shorter;
    // Wrong letter: "withdrawel" -> "withdrawal".
    if (n >= MIN_SUBSTITUTION_TOKEN) {
      const replaced = DELETES.get(shorter);
      if (replaced) return replaced;
    }
  }
  // Swapped letters: "depsoit" -> "deposit".
  for (let i = 1; i < n - 1; i++) {
    const swapped = token.slice(0, i) + token.charAt(i + 1) + token.charAt(i) + token.slice(i + 2);
    if (VOCAB.has(swapped)) return swapped;
  }
  return null;
}

const MEMO_LIMIT = 20_000;
const memo = new Map<string, string | null>();

/**
 * Concept term a misspelled lowercase token most likely stands for, or null. Only tokens of >= 5 letters (and at
 * most one letter longer than the longest term) that are not themselves concept terms are corrected, and the first
 * letter is never changed ("spending" stays itself).
 */
export function correctTypo(token: string): string | null {
  if (token.length < MIN_TYPO_TOKEN || token.length > MAX_TYPO_TOKEN) return null;
  if (VOCAB.has(token) || REAL_WORDS.has(token) || !ALPHA_RE.test(token)) return null;
  const cached = memo.get(token);
  if (cached !== undefined) return cached;
  const result = findCorrection(token);
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(token, result);
  return result;
}
