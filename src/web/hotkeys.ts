/**
 * Keyboard shortcuts.
 *   useHotkeys({ 'mod+k': openSearch, 'alt+1': () => pick(0), escape: clear }, [deps]);
 * Combo syntax: modifiers joined with "+": mod (Ctrl on Windows/Linux, Cmd on macOS), ctrl, alt, shift, meta;
 * key is KeyboardEvent.key lowercased ("k", "enter", "escape", "arrowdown", "1", "/").
 * By default, plain keys (without mod/ctrl/alt/meta) are ignored while typing in inputs/textareas/contenteditable;
 * combos with mod/ctrl/alt/meta always fire. Prefix a combo with "!" to fire even for plain keys inside inputs.
 */
import { useEffect, useRef } from 'react';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function matchCombo(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().replace(/^!/, '').split('+');
  const key = parts.pop() ?? '';
  const want = { ctrl: false, alt: false, shift: false, meta: false };
  for (const p of parts) {
    if (p === 'mod') {
      if (isMac) want.meta = true;
      else want.ctrl = true;
    } else if (p === 'ctrl' || p === 'alt' || p === 'shift' || p === 'meta') want[p] = true;
  }
  if (e.ctrlKey !== want.ctrl || e.altKey !== want.alt || e.metaKey !== want.meta) return false;
  // Shift must match exactly, except for punctuation keys that inherently need Shift (e.g. "?").
  const shiftedPunctuation = key.length === 1 && !/[a-z0-9]/.test(key);
  if (e.shiftKey !== want.shift && !shiftedPunctuation) return false;
  const k = e.key.toLowerCase();
  // With Alt on macOS, e.key may be a special character; fall back to e.code for digits/letters.
  if (k === key) return true;
  if (/^[0-9]$/.test(key) && e.code === `Digit${key}`) return true;
  if (/^[a-z]$/.test(key) && e.code === `Key${key.toUpperCase()}`) return true;
  return false;
}

export function useHotkeys(map: HotkeyMap, deps: unknown[] = []): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const [combo, fn] of Object.entries(ref.current)) {
        if (!matchCombo(combo, e)) continue;
        const hasModifier = /(^|!|\+)(mod|ctrl|alt|meta)\+/.test(combo.toLowerCase());
        if (!hasModifier && !combo.startsWith('!') && isEditable(e.target)) continue;
        e.preventDefault();
        fn(e);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Display label for a combo, e.g. "mod+k" -> "Ctrl K" / "⌘ K". */
export function comboLabel(combo: string): string {
  return combo
    .replace(/^!/, '')
    .split('+')
    .map((p) => {
      const l = p.toLowerCase();
      if (l === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (l === 'alt') return isMac ? '⌥' : 'Alt';
      if (l === 'shift') return isMac ? '⇧' : 'Shift';
      if (l === 'enter') return '↵';
      if (l === 'escape') return 'Esc';
      if (l === 'arrowdown') return '↓';
      if (l === 'arrowup') return '↑';
      return p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1);
    })
    .join(' ');
}
