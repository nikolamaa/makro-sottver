/**
 * Ctrl/Cmd+K macro palette (mounted globally by App). Fuzzy search over the in-memory macro list:
 *   Enter = use in Assist · Mod+Enter = copy the macro text · Alt+Enter = edit in Library · Esc = close.
 * While open, keys stay inside the palette (page shortcuts do not fire) and focus stays on its input.
 */
import { memo, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { renderTemplate } from '../../shared/template';
import type { Macro } from '../../shared/types';
import { matchCombo, useHotkeys } from '../hotkeys';
import { actions, useStore } from '../store';
import { Kbd, toast } from '../ui';
import { copyText } from './assist/clipboard';
import { plural, verificationBadge } from './assist/format';
import { highlightSegments, quickSearchIndexFor, searchMacros, type QuickSearchHit } from './assist/quickSearch';
import { recordCopy } from './assist/requests';
import './quicksearch.css';

type PaletteCommand = 'use' | 'copy' | 'edit';

const PAGE_JUMP = 8;
const SKELETON_ROWS = [0, 1, 2, 3, 4];

/** Copy a macro's text as-is (missing variables become [ENTER ...] placeholders) and record the use. */
async function copyMacro(macro: Macro): Promise<void> {
  const rendered = renderTemplate(macro.body, {});
  if (!(await copyText(rendered.text))) {
    toast('Copy failed', 'danger');
    return;
  }
  const left = rendered.placeholders.length;
  toast(left ? `Copied - ${plural(left, 'placeholder')} to fill in` : 'Copied', left ? 'warning' : 'success', 2200);
  recordCopy({ macroIds: [macro.id], mode: 'fast' });
}

function runCommand(command: PaletteCommand, macro: Macro): void {
  if (command === 'use') actions.useInAssist(macro.id);
  else if (command === 'edit') actions.openInLibrary(macro.id);
  else void copyMacro(macro);
}

function commandFor(e: KeyboardEvent): PaletteCommand | null {
  if (matchCombo('mod+enter', e.nativeEvent)) return 'copy';
  if (matchCombo('alt+enter', e.nativeEvent)) return 'edit';
  if (matchCombo('enter', e.nativeEvent)) return 'use';
  return null;
}

interface RowProps {
  hit: QuickSearchHit;
  index: number;
  optionId: string;
  active: boolean;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}

const ResultRow = memo(function ResultRow({ hit, index, optionId, active, onHover, onPick }: RowProps) {
  const m = hit.macro;
  const verification = verificationBadge(m.verification);
  return (
    <li
      id={optionId}
      role="option"
      aria-selected={active}
      data-index={index}
      className={`qs-item ${active ? 'is-active' : ''}`}
      onMouseMove={() => onHover(index)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(index)}
    >
      <span className={`qs-dot qs-dot-${m.verification}`} title={verification.label} />
      <span className="qs-main">
        <span className="qs-title">
          {highlightSegments(m.title, hit.titleRanges).map((seg, i) => (seg.match ? <mark key={i}>{seg.text}</mark> : seg.text))}
        </span>
        <span className="qs-sub">
          <span>{hit.categoryName ?? 'Uncategorized'}</span>
          {m.shortcut ? <code>{m.shortcut}</code> : null}
          <span className="qs-verification">{verification.label}</span>
        </span>
      </span>
      <span className="qs-side">
        {m.isFavorite ? (
          <span className="qs-star" aria-label="Favorite">
            ★
          </span>
        ) : null}
        <span title="Times used">{m.useCount}×</span>
      </span>
    </li>
  );
});

function PaletteResults({ hits, query, loaded, listId, active, onHover, onPick }: {
  hits: QuickSearchHit[];
  query: string;
  loaded: boolean;
  listId: string;
  active: number;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}) {
  if (!loaded) {
    return (
      <ul className="qs-list" aria-hidden>
        {SKELETON_ROWS.map((i) => (
          <li key={i} className="qs-skeleton" />
        ))}
      </ul>
    );
  }
  return (
    <ul className="qs-list" id={listId} role="listbox" aria-label="Macros">
      {hits.length ? (
        hits.map((hit, i) => (
          <ResultRow key={hit.macro.id} hit={hit} index={i} optionId={`${listId}-${i}`} active={i === active} onHover={onHover} onPick={onPick} />
        ))
      ) : (
        <li className="qs-empty" role="presentation">
          {query.trim() ? `No macros match "${query.trim()}"` : 'No macros yet - add or import some in the Library.'}
        </li>
      )}
    </ul>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const macros = useStore((s) => s.macros);
  const categories = useStore((s) => s.categories);
  const loaded = useStore((s) => s.loaded);
  const index = useMemo(() => quickSearchIndexFor(macros, categories), [macros, categories]);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const hits = useMemo(() => searchMacros(index, deferredQuery), [index, deferredQuery]);
  const [active, setActive] = useState(0);
  const [shownHits, setShownHits] = useState(hits);
  if (shownHits !== hits) {
    setShownHits(hits);
    setActive(0);
  }
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hitsRef = useRef(hits);
  useLayoutEffect(() => {
    hitsRef.current = hits;
  }, [hits]);

  // Focus the input on open and give focus back to where it was on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const execute = useCallback(
    (command: PaletteCommand, at: number) => {
      const hit = hitsRef.current[at];
      if (!hit) return;
      onClose();
      runCommand(command, hit.macro);
    },
    [onClose],
  );
  const onPick = useCallback((at: number) => execute('use', at), [execute]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (matchCombo('mod+k', e.nativeEvent)) return; // the global toggle closes the palette
    e.stopPropagation(); // page shortcuts stay quiet while the palette is open
    const count = hits.length;
    const command = commandFor(e);
    if (command) {
      e.preventDefault();
      execute(command, active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // focus trap: the input is the only focusable element
    } else if (count && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (count && (e.key === 'PageDown' || e.key === 'PageUp')) {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(count - 1, a + (e.key === 'PageDown' ? PAGE_JUMP : -PAGE_JUMP))));
    }
  };

  return (
    <div className="qs-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="qs-dialog" role="dialog" aria-modal="true" aria-label="Search macros" onKeyDown={onKeyDown}>
        <div className="qs-search">
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={hits.length ? `${listId}-${active}` : undefined}
            value={query}
            placeholder="Search macros by title, shortcut, tag or text…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Kbd combo="escape" />
        </div>
        <div ref={listRef} className={query !== deferredQuery ? 'qs-pending' : undefined}>
          <PaletteResults hits={hits} query={deferredQuery} loaded={loaded} listId={listId} active={active} onHover={setActive} onPick={onPick} />
        </div>
        <div className="qs-footer">
          <span>
            <Kbd combo="enter" /> use in Assist
          </span>
          <span>
            <Kbd combo="mod+enter" /> copy text
          </span>
          <span>
            <Kbd combo="alt+enter" /> edit
          </span>
          <span className="qs-count">{loaded ? plural(hits.length, 'result') : ''}</span>
        </div>
      </div>
    </div>
  );
}

/** Global Ctrl/Cmd+K quick-search palette. */
export function QuickSearch() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useHotkeys({ 'mod+k': () => setOpen((o) => !o) }, []);
  return open ? <Palette onClose={close} /> : null;
}
