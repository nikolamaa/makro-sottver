/**
 * Word diff for the version history, bounded in time so the UI never freezes.
 *
 * diffWords (jsdiff) is O(N·D): two very different 20k-character bodies take seconds on the main thread.
 * The diff is therefore aborted after DIFF_TIMEOUT_MS and both texts are shown whole instead. diffWords also
 * ignores whitespace, so when the only change is spacing or line breaks (common when editing a reply's
 * paragraphs) the whitespace-aware diff is used to make that change visible.
 */
import { diffWords, diffWordsWithSpace, type ChangeObject } from 'diff';

export interface DiffPart {
  value: string;
  added: boolean;
  removed: boolean;
}

/**
 * - same: texts are identical
 * - words: normal word diff
 * - whitespace: only spacing / line breaks differ
 * - whole: too many changes to diff in time; old text removed + new text added
 */
export type DiffMode = 'same' | 'words' | 'whitespace' | 'whole';

export interface WordDiff {
  parts: DiffPart[];
  mode: DiffMode;
}

export const DIFF_TIMEOUT_MS = 150;

const part = (c: ChangeObject<string>): DiffPart => ({ value: c.value, added: !!c.added, removed: !!c.removed });
const hasChanges = (parts: readonly ChangeObject<string>[]) => parts.some((p) => p.added || p.removed);

export function wordDiff(from: string, to: string, timeout: number = DIFF_TIMEOUT_MS): WordDiff {
  if (from === to) return { parts: from ? [{ value: from, added: false, removed: false }] : [], mode: 'same' };
  const words = diffWords(from, to, { timeout });
  if (words && hasChanges(words)) return { parts: words.map(part), mode: 'words' };
  if (words) {
    const spaced = diffWordsWithSpace(from, to, { timeout });
    if (spaced && hasChanges(spaced)) return { parts: spaced.map(part), mode: 'whitespace' };
  }
  const parts: DiffPart[] = [];
  if (from) parts.push({ value: from, added: false, removed: true });
  if (to) parts.push({ value: to, added: true, removed: false });
  return { parts, mode: 'whole' };
}

/**
 * Make a whitespace-only change visible: spaces as "·", tabs as "→", line breaks as "↵".
 * `keepBreaks` keeps the real line break after "↵" (for added text, so the current layout is preserved).
 */
export function visibleWhitespace(value: string, keepBreaks = false): string {
  return value
    .replace(/ /g, '·')
    .replace(/\t/g, '→')
    .replace(/\r?\n/g, keepBreaks ? '↵\n' : '↵');
}
