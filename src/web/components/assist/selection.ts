/**
 * Recommendation selection rules (pure). The selection is an ordered list of macro ids: the first one is the
 * primary macro, further ids are combined into the same reply in that order. The select/toggle/step functions
 * return the new selection, or null when the request changes nothing.
 */
import type { Id, Intent, RecommendResponse } from '../../../shared/types';

/** Maximum number of macros combined into one reply (server limit). */
export const MAX_COMBINE = 3;

function sameIds(a: readonly Id[], b: readonly Id[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Select only the recommendation at `index`. */
export function selectOnly(current: readonly Id[], recIds: readonly Id[], index: number): Id[] | null {
  const id = recIds[index];
  if (id === undefined) return null;
  const next = [id];
  return sameIds(current, next) ? null : next;
}

/**
 * Add the recommendation at `index` to the combined reply, or remove it when already included.
 * The last remaining macro cannot be removed. Returns 'limit' when MAX_COMBINE macros are already selected.
 */
export function toggleCombine(current: readonly Id[], recIds: readonly Id[], index: number): Id[] | 'limit' | null {
  const id = recIds[index];
  if (id === undefined) return null;
  if (current.includes(id)) return current.length > 1 ? current.filter((x) => x !== id) : null;
  if (current.length >= MAX_COMBINE) return 'limit';
  return [...current, id];
}

/** Move the (single) selection to the next/previous recommendation, clamped to the list. */
export function stepSelection(current: readonly Id[], recIds: readonly Id[], delta: 1 | -1): Id[] | null {
  if (!recIds.length) return null;
  const at = current[0] === undefined ? -1 : recIds.indexOf(current[0]);
  const target = at < 0 ? (delta > 0 ? 0 : recIds.length - 1) : Math.max(0, Math.min(recIds.length - 1, at + delta));
  return selectOnly(current, recIds, target);
}

/** Intents the customer asked about that none of the selected macros cover, with the card that covers them. */
export function uncoveredHint(result: RecommendResponse, selectedIds: readonly Id[]): { intents: Intent[]; coverRank: number } {
  const recs = result.recommendations;
  const covered = new Set(recs.filter((r) => selectedIds.includes(r.macroId)).flatMap((r) => r.coversIntents));
  const intents = result.uncoveredIntents.filter((i) => !covered.has(i));
  const coverRank = recs.findIndex((r) => !selectedIds.includes(r.macroId) && r.coversIntents.some((i) => intents.includes(i)));
  return { intents, coverRank };
}
