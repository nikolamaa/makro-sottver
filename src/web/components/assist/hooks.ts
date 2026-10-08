/**
 * Small React hooks used by the Assist page.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { matchCombo } from '../../hotkeys';

/** `value`, updated only after it stopped changing for `ms` milliseconds. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Handler for a scoped hotkey; return false to let the key through to other listeners. */
export type ScopedHotkeyHandler = (e: KeyboardEvent) => boolean;

/**
 * Capture-phase hotkeys that only fire while focus is inside `scopeRef` (or nowhere in particular), and that
 * win over the global bubbling-phase hotkeys from useHotkeys: a handled key is not seen by them.
 * Used for page-scoped combos such as Assist's Alt+Shift+1..3 (combine macros).
 */
export function useScopedCaptureHotkeys(scopeRef: RefObject<HTMLElement | null>, map: Record<string, ScopedHotkeyHandler>): void {
  const mapRef = useRef(map);
  useLayoutEffect(() => {
    mapRef.current = map;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const scope = scopeRef.current;
      const target = e.target;
      if (!scope || !(target instanceof Node) || !(target === document.body || scope.contains(target))) return;
      for (const [combo, handler] of Object.entries(mapRef.current)) {
        if (!matchCombo(combo, e)) continue;
        if (!handler(e)) return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [scopeRef]);
}

/** Grow a textarea with its content (up to its CSS max-height) whenever `value` changes. */
export function useAutoHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [ref, value]);
}
