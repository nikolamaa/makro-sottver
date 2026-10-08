/**
 * Minimal global store (no external state library). The whole decrypted macro library is small enough to keep
 * in memory on the client, which makes quick search instant.
 *
 *   const macros = useStore((s) => s.macros);
 *   await actions.loadAll();
 */
import { useSyncExternalStore } from 'react';
import type { HealthResponse } from '../shared/api';
import type { AppSettings, Category, Id, Macro } from '../shared/types';
import { api } from './api';

export type Page = 'assist' | 'library' | 'import' | 'settings';

export interface AppState {
  loaded: boolean;
  loadError: string | null;
  macros: Macro[];
  categories: Category[];
  settings: AppSettings | null;
  health: HealthResponse | null;
  page: Page;
  /** Macro to open in the Library editor (set by quick search / Assist "edit"). */
  libraryFocusId: Id | null;
  /** Macro chosen from quick search to use on the Assist page. */
  assistPickId: Id | null;
}

let state: AppState = {
  loaded: false,
  loadError: null,
  macros: [],
  categories: [],
  settings: null,
  health: null,
  page: pageFromHash(),
  libraryFocusId: null,
  assistPickId: null,
};

const listeners = new Set<() => void>();

/**
 * Navigation guard (e.g. the Library with unsaved changes). Returns true when it takes over the navigation:
 * it must then call `proceed()` itself if the user confirms leaving.
 */
export type NavigationGuard = (to: Page, proceed: () => void) => boolean;
let navigationGuard: NavigationGuard | null = null;

function pageFromHash(): Page {
  const h = typeof location !== 'undefined' ? location.hash.replace(/^#\/?/, '') : '';
  return h === 'library' || h === 'import' || h === 'settings' ? h : 'assist';
}

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

function sortMacros(list: Macro[]): Macro[] {
  return [...list].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

export const actions = {
  async loadAll(): Promise<void> {
    try {
      const [macros, categories, settings, health] = await Promise.all([
        api('GET /api/macros'),
        api('GET /api/categories'),
        api('GET /api/settings'),
        api('GET /api/health'),
      ]);
      setState({ macros: sortMacros(macros), categories, settings, health, loaded: true, loadError: null });
    } catch (err) {
      setState({ loaded: true, loadError: err instanceof Error ? err.message : String(err) });
    }
  },
  async refreshMacros(): Promise<void> {
    const macros = await api('GET /api/macros');
    setState({ macros: sortMacros(macros) });
  },
  async refreshCategories(): Promise<void> {
    setState({ categories: await api('GET /api/categories') });
  },
  async refreshHealth(): Promise<void> {
    setState({ health: await api('GET /api/health') });
  },
  /** Insert or replace a macro in the local list (archived macros are removed). */
  upsertMacro(m: Macro): void {
    setState((s) => ({
      macros: m.archivedAt ? s.macros.filter((x) => x.id !== m.id) : sortMacros([...s.macros.filter((x) => x.id !== m.id), m]),
    }));
  },
  removeMacro(id: Id): void {
    setState((s) => ({ macros: s.macros.filter((x) => x.id !== id) }));
  },
  setSettings(settings: AppSettings): void {
    setState({ settings });
  },
  navigate(page: Page): void {
    const go = () => {
      if (typeof location !== 'undefined' && location.hash !== `#/${page}`) location.hash = `#/${page}`;
      setState({ page });
    };
    if (page !== state.page && navigationGuard?.(page, go)) return;
    go();
  },
  /** Install (or clear with null) the guard consulted before leaving the current page. */
  setNavigationGuard(guard: NavigationGuard | null): void {
    navigationGuard = guard;
  },
  openInLibrary(id: Id): void {
    setState({ libraryFocusId: id });
    actions.navigate('library');
  },
  useInAssist(id: Id): void {
    setState({ assistPickId: id });
    actions.navigate('assist');
  },
};

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const to = pageFromHash();
    if (to === state.page) return;
    const from = state.page;
    const go = () => {
      if (location.hash !== `#/${to}`) location.hash = `#/${to}`;
      setState({ page: to });
    };
    if (navigationGuard?.(to, go)) {
      // Undo the hash change (browser Back / typed URL) until the guard lets us leave.
      history.replaceState(null, '', `#/${from}`);
      return;
    }
    go();
  });
}

export function categoryName(categories: Category[], id: Id | null): string | null {
  if (!id) return null;
  return categories.find((c) => c.id === id)?.name ?? null;
}
