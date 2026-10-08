/**
 * Small request helpers for the Assist page and quick search: fire-and-forget usage events, favorites and
 * error normalization. Events carry ids, ranks and scores only - never customer text.
 */
import type { Macro, UsageEventInput } from '../../../shared/types';
import { api } from '../../api';
import { actions } from '../../store';
import { toast } from '../../ui';

/** Record a usage event. Best effort: analytics must never interrupt the agent. */
export function sendEvent(event: UsageEventInput): Promise<void> {
  return api('POST /api/events', { body: event }).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Record a copied reply. The server bumps the macros' use counts; once it confirmed, the same bump is applied to
 * the local list (no full library refetch: only useCount/lastUsedAt of these macros changed).
 */
export function recordCopy(event: Omit<UsageEventInput, 'type'>): void {
  const ids = event.macroIds ?? [];
  void api('POST /api/events', { body: { type: 'reply_copied', ...event } }).then(
    () => {
      if (ids.length) actions.recordUse(ids, new Date().toISOString());
    },
    () => undefined,
  );
}

/** True when a request was cancelled by an AbortController (superseded input). */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Human-readable message for a failed request. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Flip a macro's favorite flag on the server and update the local list. Errors are toasted. */
export async function toggleFavorite(macro: Pick<Macro, 'id' | 'isFavorite'>): Promise<void> {
  try {
    const updated = await api('POST /api/macros/:id/favorite', { params: { id: macro.id }, body: { favorite: !macro.isFavorite } });
    actions.upsertMacro(updated);
  } catch (err) {
    toast(`Could not update the favorite: ${errorText(err)}`, 'danger');
  }
}
