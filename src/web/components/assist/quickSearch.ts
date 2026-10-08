/**
 * In-memory macro search for the Ctrl/Cmd+K palette. Build the index once per macro list (memoize it) and
 * query it on every keystroke: fuzzy matching (uFuzzy, typo tolerant, out-of-order terms) over
 * "title shortcut tags category", followed by a plain substring fallback over macro bodies.
 * Stays well under a frame for 2000 macros.
 */
import uFuzzy from '@leeoniya/ufuzzy';
import type { Category, Id, Macro } from '../../../shared/types';

export interface QuickSearchIndex {
  macros: readonly Macro[];
  /** Per macro: "title shortcut tags category" (original case, title first). */
  haystack: string[];
  /** Lowercased bodies for the substring fallback. */
  bodies: string[];
  categoryNames: (string | null)[];
  /** Macro indexes ordered favorites first, then most used, then most recent. */
  defaultOrder: number[];
  /** Position of each macro in defaultOrder (used to rank unranked matches). */
  defaultRank: Int32Array;
}

export interface QuickSearchHit {
  macro: Macro;
  categoryName: string | null;
  /** Highlight ranges within the title: [start0, end0, start1, end1, ...]. */
  titleRanges: number[];
}

export const DEFAULT_RESULT_LIMIT = 50;
/** Out-of-order permutations of up to this many query terms ("pending withdrawal" finds "Withdrawal pending"). */
const OUT_OF_ORDER_TERMS = 3;
const MIN_BODY_QUERY = 2;

const fuzzy = new uFuzzy({
  intraMode: 1 as uFuzzy.IntraMode,
  intraIns: 1,
  intraSub: 1,
  intraTrn: 1,
  intraDel: 1,
});

function recency(m: Macro): string {
  return m.lastUsedAt ?? m.updatedAt;
}

function compareDefault(a: Macro, b: Macro): number {
  if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
  if (a.useCount !== b.useCount) return b.useCount - a.useCount;
  const ra = recency(a);
  const rb = recency(b);
  return ra === rb ? 0 : ra > rb ? -1 : 1;
}

/** Build the search index. O(n log n); call it only when the macro or category list changes. */
export function buildQuickSearchIndex(macros: readonly Macro[], categories: readonly Category[]): QuickSearchIndex {
  const names = new Map<Id, string>(categories.map((c) => [c.id, c.name]));
  const categoryNames = macros.map((m) => (m.categoryId ? (names.get(m.categoryId) ?? null) : null));
  const haystack = macros.map((m, i) => [m.title, m.shortcut, m.tags.join(' '), categoryNames[i] ?? ''].join(' '));
  const bodies = macros.map((m) => m.body.toLowerCase());
  const defaultOrder = macros.map((_, i) => i).sort((a, b) => compareDefault(macros[a]!, macros[b]!));
  const defaultRank = new Int32Array(macros.length);
  defaultOrder.forEach((macroIdx, rank) => {
    defaultRank[macroIdx] = rank;
  });
  return { macros, haystack, bodies, categoryNames, defaultOrder, defaultRank };
}

/** Keep the parts of haystack highlight ranges that fall inside the title (the haystack's prefix), sorted. */
function clipToTitle(ranges: readonly number[] | undefined, titleLength: number): number[] {
  if (!ranges) return [];
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = ranges[i]!;
    if (start < titleLength) pairs.push([start, Math.min(ranges[i + 1]!, titleLength)]);
  }
  return pairs.sort((a, b) => a[0] - b[0]).flat();
}

function hit(index: QuickSearchIndex, macroIdx: number, titleRanges: number[] = []): QuickSearchHit {
  return { macro: index.macros[macroIdx]!, categoryName: index.categoryNames[macroIdx] ?? null, titleRanges };
}

/** Fuzzy matches, best first. Falls back to default ordering when uFuzzy skips ranking (very broad queries). */
function fuzzyHits(index: QuickSearchIndex, query: string, limit: number): QuickSearchHit[] {
  const [idxs, info, order] = fuzzy.search(index.haystack, query, OUT_OF_ORDER_TERMS);
  if (!idxs) return [];
  if (info && order) {
    return order.slice(0, limit).map((o) => {
      const macroIdx = info.idx[o]!;
      return hit(index, macroIdx, clipToTitle(info.ranges[o], index.macros[macroIdx]!.title.length));
    });
  }
  return [...idxs]
    .sort((a, b) => index.defaultRank[a]! - index.defaultRank[b]!)
    .slice(0, limit)
    .map((macroIdx) => hit(index, macroIdx));
}

/**
 * Search macros. Empty query -> default ordering (favorites, most used, recent). Otherwise fuzzy matches on
 * title/shortcut/tags/category, topped up with macros whose body contains the query.
 */
export function searchMacros(index: QuickSearchIndex, query: string, limit = DEFAULT_RESULT_LIMIT): QuickSearchHit[] {
  const q = query.trim();
  if (!q) return index.defaultOrder.slice(0, limit).map((i) => hit(index, i));
  const hits = fuzzyHits(index, q, limit);
  if (hits.length >= limit || q.length < MIN_BODY_QUERY) return hits;
  const seen = new Set(hits.map((h) => h.macro.id));
  const needle = q.toLowerCase();
  for (const macroIdx of index.defaultOrder) {
    if (hits.length >= limit) break;
    const macro = index.macros[macroIdx]!;
    if (!seen.has(macro.id) && index.bodies[macroIdx]!.includes(needle)) hits.push(hit(index, macroIdx));
  }
  return hits;
}

/** Split a title into plain/highlighted segments for rendering. */
export function highlightSegments(title: string, ranges: readonly number[]): { text: string; match: boolean }[] {
  if (!ranges.length) return [{ text: title, match: false }];
  const out: { text: string; match: boolean }[] = [];
  let pos = 0;
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = ranges[i]!;
    const end = ranges[i + 1]!;
    if (start > pos) out.push({ text: title.slice(pos, start), match: false });
    if (end > start) out.push({ text: title.slice(start, end), match: true });
    pos = Math.max(pos, end);
  }
  if (pos < title.length) out.push({ text: title.slice(pos), match: false });
  return out;
}
