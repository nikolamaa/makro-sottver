/**
 * Library list filtering + sorting. Fuzzy search (uFuzzy, typo tolerant, any term order) over
 * title / shortcut / tags / category, with a plain substring fallback over the reply body.
 */
import uFuzzy from '@leeoniya/ufuzzy';
import type { Category, Id, Macro } from '../../../shared/types';

export type SortKey = 'relevance' | 'title' | 'mostUsed' | 'recentlyUsed' | 'recentlyUpdated';

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'relevance', label: 'Best match' },
  { value: 'title', label: 'Title' },
  { value: 'mostUsed', label: 'Most used' },
  { value: 'recentlyUsed', label: 'Recently used' },
  { value: 'recentlyUpdated', label: 'Recently updated' },
];

export function isSortKey(v: unknown): v is SortKey {
  return SORT_OPTIONS.some((o) => o.value === v);
}

/** 'all', 'none' (uncategorized) or a category id. */
export type CategoryFilter = 'all' | 'none' | Id;

export interface MacroFilters {
  query: string;
  category: CategoryFilter;
  favorites: boolean;
  attention: boolean;
}

export const EMPTY_FILTERS: MacroFilters = { query: '', category: 'all', favorites: false, attention: false };

export function hasActiveFilters(f: MacroFilters): boolean {
  return f.query.trim() !== '' || f.category !== 'all' || f.favorites || f.attention;
}

/** Footer count, e.g. "12 macros" or "1 of 4 macros" when filters / archived rows narrow or widen the list. */
export function countLabel(shown: number, total: number, partial: boolean): string {
  const noun = (n: number) => (n === 1 ? 'macro' : 'macros');
  return partial ? `${shown} of ${total} ${noun(total)}` : `${shown} ${noun(shown)}`;
}

export function needsAttention(m: Macro): boolean {
  return m.verification === 'outdated' || m.verification === 'conflict' || m.verification === 'unverified';
}

const fuzzy = new uFuzzy({ intraMode: 1 });
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

const byTitle = (a: Macro, b: Macro) => collator.compare(a.title, b.title);
const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

const COMPARATORS: Record<Exclude<SortKey, 'relevance'>, (a: Macro, b: Macro) => number> = {
  title: byTitle,
  mostUsed: (a, b) => b.useCount - a.useCount || time(b.lastUsedAt) - time(a.lastUsedAt) || byTitle(a, b),
  recentlyUsed: (a, b) => time(b.lastUsedAt) - time(a.lastUsedAt) || b.useCount - a.useCount || byTitle(a, b),
  recentlyUpdated: (a, b) => time(b.updatedAt) - time(a.updatedAt) || byTitle(a, b),
};

/** Searchable text per macro (built once per library change). */
export function buildHaystack(macros: Macro[], categories: Category[]): string[] {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  return macros.map((m) =>
    [m.title, m.shortcut, m.tags.join(' '), m.categoryId ? (names.get(m.categoryId) ?? '') : ''].filter(Boolean).join(' · '),
  );
}

/** Indexes of `macros` matching `query`, best first. */
function searchIndexes(macros: Macro[], haystack: string[], query: string): number[] {
  const q = query.trim();
  const out: number[] = [];
  const seen = new Set<number>();
  if (/[A-Za-z0-9]/.test(q)) {
    const [idxs, info, order] = fuzzy.search(haystack, q, 3);
    if (idxs) {
      if (info && order) {
        for (const o of order) {
          const i = info.idx[o];
          if (i !== undefined && !seen.has(i)) {
            seen.add(i);
            out.push(i);
          }
        }
      } else {
        for (const i of idxs) if (!seen.has(i)) {
          seen.add(i);
          out.push(i);
        }
      }
    }
  }
  // Exact (case-insensitive) substring hits in title/shortcut/tags that fuzzy matching missed (e.g. symbols).
  const lower = q.toLowerCase();
  haystack.forEach((h, i) => {
    if (!seen.has(i) && h.toLowerCase().includes(lower)) {
      seen.add(i);
      out.push(i);
    }
  });
  // Fallback: reply body contains the query.
  if (lower.length >= 2) {
    macros.forEach((m, i) => {
      if (!seen.has(i) && m.body.toLowerCase().includes(lower)) {
        seen.add(i);
        out.push(i);
      }
    });
  }
  return out;
}

export function filterAndSort(macros: Macro[], haystack: string[], filters: MacroFilters, sort: SortKey): Macro[] {
  const pass = (m: Macro) =>
    (filters.category === 'all' || (filters.category === 'none' ? !m.categoryId : m.categoryId === filters.category)) &&
    (!filters.favorites || m.isFavorite) &&
    (!filters.attention || needsAttention(m));

  const query = filters.query.trim();
  let list: Macro[];
  if (query) {
    list = [];
    for (const i of searchIndexes(macros, haystack, query)) {
      const m = macros[i];
      if (m && pass(m)) list.push(m);
    }
  } else {
    list = macros.filter(pass);
  }
  if (sort === 'relevance') return query ? list : [...list].sort(byTitle);
  return [...list].sort(COMPARATORS[sort]);
}
