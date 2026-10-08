/**
 * Unsaved Library editor state kept in memory while the Library page is not mounted (the agent left through
 * quick search or the browser Back button). It is never written to storage. While something is stashed, the
 * browser still asks before the tab is reloaded or closed (beforeunload), exactly as on the Library page itself.
 */

function onBeforeUnload(e: BeforeUnloadEvent): void {
  e.preventDefault();
  // Legacy browsers only show the prompt when returnValue is set.
  e.returnValue = '';
}

export interface UnsavedStash<T> {
  /** Keep `value` (null clears the stash). */
  keep(value: T | null): void;
  /** Return the stashed value and clear the stash. */
  take(): T | null;
  has(): boolean;
}

export function createUnsavedStash<T>(): UnsavedStash<T> {
  let value: T | null = null;
  const set = (next: T | null) => {
    value = next;
    if (typeof window === 'undefined') return;
    // add/removeEventListener with the same function reference are idempotent.
    if (next !== null) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
  };
  return {
    keep: set,
    take() {
      const v = value;
      set(null);
      return v;
    },
    has: () => value !== null,
  };
}
