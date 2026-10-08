/**
 * Access token for the local API (header X-MacroPilot on every request).
 *
 * The launcher opens `http://localhost:<port>/#/assist?k=<token>`. On load the token is taken from the URL
 * fragment (which is never sent to the server), remembered in localStorage and removed from the address bar, keeping
 * the `#/page` route. Without a valid token the server answers 403 API_ACCESS_DENIED and App shows how to open
 * MacroPilot from the launcher.
 */
import { useSyncExternalStore } from 'react';

export const ACCESS_STORAGE_KEY = 'macropilot.access';
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

let token: string | null = null;
let denied = false;
const listeners = new Set<() => void>();

function readStored(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(ACCESS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(value: string): void {
  try {
    localStorage.setItem(ACCESS_STORAGE_KEY, value);
  } catch {
    // Private mode / blocked storage: the token still works for this page load.
  }
}

/**
 * Split a location hash like `#/assist?k=abc` into the token and the hash without it (`#/assist`).
 * Returns token null when the hash carries none.
 */
export function takeTokenFromHash(hash: string): { token: string | null; hash: string } {
  const q = hash.indexOf('?');
  if (q < 0) return { token: null, hash };
  const params = new URLSearchParams(hash.slice(q + 1));
  const k = params.get('k');
  if (k === null) return { token: null, hash };
  params.delete('k');
  const rest = params.toString();
  const route = hash.slice(0, q) || '#/assist';
  return { token: TOKEN_RE.test(k) ? k : null, hash: rest ? `${route}?${rest}` : route };
}

/** Read the token from the URL (and clean the URL) or from localStorage. Runs once when this module loads. */
export function initAccess(): void {
  token = readStored();
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const taken = takeTokenFromHash(location.hash);
  if (taken.hash === location.hash) return;
  if (taken.token) {
    token = taken.token;
    store(taken.token);
  }
  // Remove the token from the address bar and the current history entry (replaceState fires no hashchange).
  history.replaceState(history.state, '', `${location.pathname}${location.search}${taken.hash}`);
}

export function accessToken(): string | null {
  return token;
}

/** Called by the API client when the server rejected the token. */
export function markAccessDenied(): void {
  if (denied) return;
  denied = true;
  for (const l of listeners) l();
}

export function isAccessDenied(): boolean {
  return denied;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAccessDenied(): boolean {
  return useSyncExternalStore(subscribe, isAccessDenied);
}

initAccess();
