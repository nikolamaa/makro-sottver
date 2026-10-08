/**
 * Assist page keyboard shortcuts and the compact legend shown at the bottom of the page.
 */
import { memo, useEffect, useMemo, type RefObject } from 'react';
import { matchCombo, useHotkeys, type HotkeyMap } from '../../hotkeys';
import { Kbd } from '../../ui';
import { shortcutReadsClipboard } from './clipboard';
import { useScopedCaptureHotkeys, type ScopedHotkeyHandler } from './hooks';
import type { AssistActions } from './useAssist';

const RANKS = [0, 1, 2] as const;
const READ_CLIPBOARD = 'mod+shift+v';

/** Elements the Assist shortcuts depend on. */
export interface AssistHotkeyRefs {
  /** The page: Alt+Shift+1..3 combine only while focus is inside it. */
  page: RefObject<HTMLElement | null>;
  /** The customer message box: Mod+Shift+V reads the clipboard here, but not in other text fields. */
  message: RefObject<HTMLTextAreaElement | null>;
}

/** Mod+Shift+V loads the clipboard as the message, except in other text fields (native "paste as plain text"). */
function useReadClipboardHotkey(actions: AssistActions, messageRef: RefObject<HTMLTextAreaElement | null>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchCombo(READ_CLIPBOARD, e) || !shortcutReadsClipboard(e.target, messageRef.current)) return;
      e.preventDefault();
      void actions.readClipboard();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, messageRef]);
}

/**
 * Register the Assist shortcuts. Alt+Shift+1..3 (combine) are scoped to this page and only fire when that
 * recommendation card exists.
 */
export function useAssistHotkeys(actions: AssistActions, refs: AssistHotkeyRefs, recommendationCount: number): void {
  const keys = useMemo<HotkeyMap>(
    () => ({
      ...Object.fromEntries(RANKS.flatMap((i) => [[`alt+${i + 1}`, () => actions.select(i)], [`${i + 1}`, () => actions.select(i)]])),
      'alt+arrowdown': () => actions.step(1),
      'alt+arrowup': () => actions.step(-1),
      'mod+enter': () => void actions.copy(),
      'mod+j': actions.polish,
      'mod+e': actions.focusEditor,
      'alt+m': actions.focusMessage,
      escape: actions.clear,
    }),
    [actions],
  );
  const combineKeys = useMemo<Record<string, ScopedHotkeyHandler>>(
    () =>
      Object.fromEntries(
        RANKS.map((i) => [
          `alt+shift+${i + 1}`,
          () => {
            if (i >= recommendationCount) return false;
            actions.toggleCombine(i);
            return true;
          },
        ]),
      ),
    [actions, recommendationCount],
  );
  useHotkeys(keys, [keys]);
  useScopedCaptureHotkeys(refs.page, combineKeys);
  useReadClipboardHotkey(actions, refs.message);
}

const LEGEND: { combo: string; label: string }[] = [
  { combo: 'alt+1', label: 'pick 1-3' },
  { combo: 'alt+shift+2', label: 'combine' },
  { combo: 'alt+arrowdown', label: 'next' },
  { combo: 'mod+enter', label: 'copy' },
  { combo: 'mod+e', label: 'edit reply' },
  { combo: 'mod+j', label: 'AI polish' },
  { combo: 'alt+m', label: 'message' },
  { combo: READ_CLIPBOARD, label: 'read clipboard' },
  { combo: 'escape', label: 'clear' },
  { combo: 'mod+k', label: 'search macros' },
];

/** Compact keyboard legend. */
export const ShortcutLegend = memo(function ShortcutLegend() {
  return (
    <footer className="assist-legend" aria-label="Keyboard shortcuts">
      {LEGEND.map((s) => (
        <span key={s.combo} className="assist-legend-item">
          <Kbd combo={s.combo} /> {s.label}
        </span>
      ))}
    </footer>
  );
});
