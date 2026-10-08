/**
 * Assist page keyboard shortcuts and the compact legend shown at the bottom of the page.
 */
import { memo, type RefObject } from 'react';
import { useHotkeys } from '../../hotkeys';
import { Kbd } from '../../ui';
import { useScopedCaptureHotkeys } from './hooks';
import type { AssistActions } from './useAssist';

const RANKS = [0, 1, 2] as const;

/**
 * Register the Assist shortcuts. Alt+Shift+1..3 (combine) also switch pages globally, so they are taken in
 * the capture phase while focus is on this page - and only when that recommendation card exists.
 */
export function useAssistHotkeys(actions: AssistActions, scopeRef: RefObject<HTMLElement | null>, recommendationCount: number): void {
  useHotkeys(
    {
      ...Object.fromEntries(RANKS.flatMap((i) => [[`alt+${i + 1}`, () => actions.select(i)], [`${i + 1}`, () => actions.select(i)]])),
      'alt+arrowdown': () => actions.step(1),
      'alt+arrowup': () => actions.step(-1),
      'mod+enter': () => void actions.copy(),
      'mod+j': actions.polish,
      'mod+e': actions.focusEditor,
      'alt+m': actions.focusMessage,
      'mod+shift+v': () => void actions.readClipboard(),
      escape: actions.clear,
    },
    [actions],
  );
  useScopedCaptureHotkeys(
    scopeRef,
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
  );
}

const LEGEND: { combo: string; label: string }[] = [
  { combo: 'alt+1', label: 'pick 1-3' },
  { combo: 'alt+shift+2', label: 'combine' },
  { combo: 'alt+arrowdown', label: 'next' },
  { combo: 'mod+enter', label: 'copy' },
  { combo: 'mod+e', label: 'edit reply' },
  { combo: 'mod+j', label: 'AI polish' },
  { combo: 'alt+m', label: 'message' },
  { combo: 'mod+shift+v', label: 'read clipboard' },
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
