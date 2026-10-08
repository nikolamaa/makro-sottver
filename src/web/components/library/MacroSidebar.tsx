/**
 * Library list column: instant fuzzy search, filters, sort and a keyboard-driven listbox.
 *   ↑/↓ (Home/End/PgUp/PgDn) move the highlight when the list is focused, Enter opens, "/" focuses search.
 *   In the search box: ↓ jumps into the list, Enter opens the highlighted (best) match, Esc clears.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Category, Id, Macro } from '../../../shared/types';
import { useHotkeys } from '../../hotkeys';
import { actions } from '../../store';
import { Badge, Button, EmptyState, Kbd, Spinner } from '../../ui';
import { SearchIcon, StarIcon, VerificationIcon } from './Icons';
import { readLocal, relativeTime, writeLocal } from './model';
import {
  EMPTY_FILTERS,
  SORT_OPTIONS,
  buildHaystack,
  filterAndSort,
  hasActiveFilters,
  isSortKey,
  needsAttention,
  type CategoryFilter,
  type MacroFilters,
  type SortKey,
} from './search';

const SORT_STORAGE_KEY = 'macropilot.library.sort';
const PAGE_STEP = 10;

export interface MacroSidebarProps {
  macros: Macro[];
  categories: Category[];
  /** Macro currently open in the editor. */
  activeId: Id | null;
  onOpen: (id: Id) => void;
  onNew: () => void;
  showArchived: boolean;
  onShowArchivedChange: (value: boolean) => void;
  archivedLoading: boolean;
}

const optionId = (id: Id) => `lib-opt-${id}`;

export const MacroSidebar = memo(function MacroSidebar({
  macros,
  categories,
  activeId,
  onOpen,
  onNew,
  showArchived,
  onShowArchivedChange,
  archivedLoading,
}: MacroSidebarProps) {
  const [filters, setFilters] = useState<MacroFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortKey>(() => {
    const saved = readLocal(SORT_STORAGE_KEY);
    return isSortKey(saved) && saved !== 'relevance' ? saved : 'title';
  });
  /** Sort explicitly picked while a search query is active (default: best match). */
  const [searchSort, setSearchSort] = useState<SortKey | null>(null);
  const [cursorId, setCursorId] = useState<Id | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollToCursor = useRef(false);

  const query = filters.query.trim();
  const effectiveSort: SortKey = query ? (searchSort ?? 'relevance') : sort;

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
    [categories],
  );
  const haystack = useMemo(() => buildHaystack(macros, categories), [macros, categories]);
  const items = useMemo(() => filterAndSort(macros, haystack, filters, effectiveSort), [macros, haystack, filters, effectiveSort]);
  const attentionCount = useMemo(() => macros.reduce((n, m) => n + (needsAttention(m) && !m.archivedAt ? 1 : 0), 0), [macros]);
  const archivedCount = useMemo(() => macros.reduce((n, m) => n + (m.archivedAt ? 1 : 0), 0), [macros]);

  // A category filter pointing at a deleted category falls back to "all".
  useEffect(() => {
    if (filters.category !== 'all' && filters.category !== 'none' && !categoryById.has(filters.category)) {
      setFilters((f) => ({ ...f, category: 'all' }));
    }
  }, [categoryById, filters.category]);

  // Highlight follows the macro opened from elsewhere (quick search, Assist "edit", New macro saved...).
  useEffect(() => {
    if (activeId) {
      scrollToCursor.current = true;
      setCursorId(activeId);
    }
  }, [activeId]);

  // Without an explicit cursor: the best match while searching, else the open macro, else the first row.
  const cursorIndex = useMemo(() => {
    const i = cursorId ? items.findIndex((m) => m.id === cursorId) : -1;
    if (i >= 0) return i;
    const open = !query && activeId ? items.findIndex((m) => m.id === activeId) : -1;
    return open >= 0 ? open : items.length ? 0 : -1;
  }, [items, cursorId, activeId, query]);
  const cursorMacro = cursorIndex >= 0 ? items[cursorIndex] : undefined;

  useEffect(() => {
    if (!scrollToCursor.current || !cursorMacro) return;
    scrollToCursor.current = false;
    document.getElementById(optionId(cursorMacro.id))?.scrollIntoView({ block: 'nearest' });
  }, [cursorMacro]);

  const moveCursor = useCallback(
    (delta: number | 'first' | 'last') => {
      if (!items.length) return;
      const from = cursorIndex < 0 ? 0 : cursorIndex;
      const to =
        delta === 'first' ? 0 : delta === 'last' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, from + delta));
      scrollToCursor.current = true;
      setCursorId(items[to]?.id ?? null);
    },
    [items, cursorIndex],
  );

  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  useHotkeys({ '/': focusSearch }, [focusSearch]);

  const setQuery = (value: string) => {
    setFilters((f) => ({ ...f, query: value }));
    if (!value.trim()) setSearchSort(null);
    // New query: highlight the best match.
    scrollToCursor.current = true;
    setCursorId(null);
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!items.length) return;
      listRef.current?.focus();
      scrollToCursor.current = true;
      setCursorId(items[Math.min(items.length - 1, cursorIndex < 0 ? 0 : cursorIndex)]?.id ?? null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (cursorMacro) onOpen(cursorMacro.id);
    } else if (e.key === 'Escape') {
      if (filters.query) {
        e.preventDefault();
        e.stopPropagation();
        setQuery('');
      } else {
        e.currentTarget.blur();
      }
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveCursor(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (cursorIndex <= 0) focusSearch();
        else moveCursor(-1);
        break;
      case 'Home':
        e.preventDefault();
        moveCursor('first');
        break;
      case 'End':
        e.preventDefault();
        moveCursor('last');
        break;
      case 'PageDown':
        e.preventDefault();
        moveCursor(PAGE_STEP);
        break;
      case 'PageUp':
        e.preventDefault();
        moveCursor(-PAGE_STEP);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (cursorMacro) onOpen(cursorMacro.id);
        break;
      default:
        // Type-to-search: printable keys go to the search box.
        if (e.key.length === 1 && e.key !== '/') searchRef.current?.focus();
    }
  };

  const onRowClick = useCallback(
    (id: Id) => {
      setCursorId(id);
      onOpen(id);
    },
    [onOpen],
  );

  const onSortChange = (value: string) => {
    if (!isSortKey(value)) return;
    if (query) setSearchSort(value);
    else if (value !== 'relevance') {
      setSort(value);
      writeLocal(SORT_STORAGE_KEY, value);
    }
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearchSort(null);
  };

  const activeCount = macros.length - archivedCount;
  const filtered = hasActiveFilters(filters);

  return (
    <aside className="lib-sidebar panel" aria-label="Macro list">
      <div className="lib-sidebar-head">
        <div className="row">
          <h1 className="lib-h1">Library</h1>
          <span className="muted small">{activeCount}</span>
          <span className="spacer" />
          <Button variant="primary" size="sm" hotkey="alt+n" onClick={onNew} title="Create a new macro">
            New macro
          </Button>
        </div>

        <div className="lib-search">
          <SearchIcon />
          <input
            ref={searchRef}
            id="lib-search"
            type="text"
            role="searchbox"
            value={filters.query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search title, shortcut, tag, text…"
            aria-label="Search macros"
            aria-controls="lib-listbox"
            autoComplete="off"
            spellCheck={false}
          />
          {filters.query ? (
            <button type="button" className="icon-btn lib-search-clear" aria-label="Clear search" onClick={() => setQuery('')}>
              ×
            </button>
          ) : (
            <Kbd combo="/" />
          )}
        </div>

        <div className="lib-filters">
          <select
            aria-label="Filter by category"
            value={filters.category}
            onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value as CategoryFilter }))}
          >
            <option value="all">All categories</option>
            <option value="none">Uncategorized</option>
            {sortedCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select aria-label="Sort macros" value={effectiveSort} onChange={(e) => onSortChange(e.target.value)}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} disabled={o.value === 'relevance' && !query}>
                {o.value === 'relevance' ? o.label : `Sort: ${o.label}`}
              </option>
            ))}
          </select>
        </div>

        <div className="lib-toggles">
          <button
            type="button"
            className="lib-chip"
            aria-pressed={filters.favorites}
            onClick={() => setFilters((f) => ({ ...f, favorites: !f.favorites }))}
          >
            <StarIcon filled={filters.favorites} size={13} /> Favorites
          </button>
          <button
            type="button"
            className="lib-chip"
            aria-pressed={filters.attention}
            onClick={() => setFilters((f) => ({ ...f, attention: !f.attention }))}
            title="Facts outdated, in conflict with the source, or not verified yet"
          >
            Needs attention <span className="lib-chip-count">{attentionCount}</span>
          </button>
          <label className="lib-check">
            <input type="checkbox" checked={showArchived} onChange={(e) => onShowArchivedChange(e.target.checked)} />
            Show archived
            <span className="lib-spin-slot">{archivedLoading ? <Spinner label="Loading archived macros" /> : null}</span>
          </label>
        </div>
      </div>

      {macros.length === 0 && !archivedLoading ? (
        <EmptyState title="No macros yet">
          <p className="lib-empty-text">Create your first macro, or import the ones you copied from Intercom.</p>
          <div className="row lib-empty-actions">
            <Button variant="primary" size="sm" onClick={onNew}>
              New macro
            </Button>
            <Button size="sm" onClick={() => actions.navigate('import')}>
              Import
            </Button>
          </div>
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState title="No macros match">
          <p className="lib-empty-text">Try another search or clear the filters.</p>
          {filtered ? (
            <Button size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <div
          ref={listRef}
          id="lib-listbox"
          className="lib-list"
          role="listbox"
          tabIndex={0}
          aria-label="Macros"
          aria-activedescendant={cursorMacro ? optionId(cursorMacro.id) : undefined}
          onKeyDown={onListKeyDown}
        >
          {items.map((m) => (
            <MacroRow
              key={m.id}
              macro={m}
              category={m.categoryId ? categoryById.get(m.categoryId) : undefined}
              open={m.id === activeId}
              cursor={m.id === cursorMacro?.id}
              sort={effectiveSort}
              onClick={onRowClick}
            />
          ))}
        </div>
      )}

      <div className="lib-sidebar-foot muted small" aria-live="polite">
        <span>
          {filtered || showArchived ? `${items.length} of ${macros.length}` : `${items.length}`} macro{items.length === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        <span className="lib-foot-keys">
          <Kbd combo="arrowup" />
          <Kbd combo="arrowdown" /> move <Kbd combo="enter" /> open
        </span>
      </div>
    </aside>
  );
});

const MacroRow = memo(function MacroRow({
  macro,
  category,
  open,
  cursor,
  sort,
  onClick,
}: {
  macro: Macro;
  category: Category | undefined;
  open: boolean;
  cursor: boolean;
  sort: SortKey;
  onClick: (id: Id) => void;
}) {
  const meta =
    sort === 'recentlyUsed'
      ? macro.lastUsedAt
        ? `used ${relativeTime(macro.lastUsedAt)}`
        : 'never used'
      : sort === 'recentlyUpdated'
        ? `updated ${relativeTime(macro.updatedAt)}`
        : [category?.name ?? 'Uncategorized', macro.shortcut ? `/${macro.shortcut}` : ''].filter(Boolean).join(' · ');
  return (
    <div
      id={optionId(macro.id)}
      role="option"
      aria-selected={open}
      className={`lib-row${open ? ' is-open' : ''}${cursor ? ' is-cursor' : ''}${macro.archivedAt ? ' is-archived' : ''}`}
      onClick={() => onClick(macro.id)}
    >
      <span
        className="lib-dot"
        style={{ background: category?.color ?? 'transparent' }}
        data-empty={category ? undefined : ''}
        title={category?.name ?? 'Uncategorized'}
        aria-hidden
      />
      <span className="lib-row-main">
        <span className="lib-row-title">{macro.title}</span>
        <span className="lib-row-meta">
          {macro.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
          <span className="lib-row-meta-text">{meta}</span>
        </span>
      </span>
      <span className="lib-row-side">
        <span className="lib-row-icons">
          {macro.isFavorite ? (
            <span className="lib-star" title="Favorite">
              <StarIcon filled size={13} label="Favorite" />
            </span>
          ) : null}
          <VerificationIcon status={macro.verification} size={13} />
        </span>
        <span className="lib-row-uses" title={`Used ${macro.useCount} time${macro.useCount === 1 ? '' : 's'}`}>
          {macro.useCount}×
        </span>
      </span>
    </div>
  );
});
