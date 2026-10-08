/**
 * Caret helpers for the reply editor: jump to placeholders so the agent can type over them.
 */
import { PLACEHOLDER_RE } from '../../../shared/template';

/** The subset of HTMLTextAreaElement these helpers need (keeps them testable without a DOM). */
export interface SelectableText {
  value: string;
  selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
}

const PLACEHOLDER_SCAN = new RegExp(PLACEHOLDER_RE.source, 'g');

function selectRange(el: SelectableText, start: number, length: number): true {
  el.focus();
  el.setSelectionRange(start, start + length);
  return true;
}

/** Select the next occurrence of `needle` after the caret, wrapping around. False when it does not occur. */
export function selectNextOccurrence(el: SelectableText, needle: string): boolean {
  if (!needle) return false;
  let at = el.value.indexOf(needle, el.selectionEnd);
  if (at < 0) at = el.value.indexOf(needle);
  return at >= 0 && selectRange(el, at, needle.length);
}

/** Select the next [ENTER ...] placeholder after the caret, wrapping around. False when none is left. */
export function selectNextPlaceholder(el: SelectableText): boolean {
  for (const from of [el.selectionEnd, 0]) {
    PLACEHOLDER_SCAN.lastIndex = from;
    const m = PLACEHOLDER_SCAN.exec(el.value);
    if (m) return selectRange(el, m.index, m[0].length);
  }
  return false;
}
