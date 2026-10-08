/**
 * Small helpers shared by the Settings page, the Import page and the onboarding dialog.
 */
import type { AppSettings, DeepPartial, EmbedderStatus } from '../../../shared/types';

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns a new object with `patch` deep-merged over `base` (arrays and primitives are replaced). */
export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return base;
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value as DeepPartial<PlainObject>) : value;
  }
  return out as T;
}

/**
 * Human-readable message for any thrown value. Download errors carry the raw response body, which may be
 * a JSON `{ "error": "..." }` document; unwrap it so toasts stay readable.
 */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isPlainObject(parsed) && typeof parsed.error === 'string') return parsed.error;
    } catch {
      /* not JSON - fall through */
    }
  }
  return trimmed || 'Something went wrong';
}

/** Trigger a browser download for in-memory text (no server round trip). */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatUsd(value: number, decimals = 4): string {
  return `$${(Number.isFinite(value) ? value : 0).toFixed(decimals)}`;
}

export function formatInt(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(Number.isFinite(value) ? value : 0));
}

/** sessionStorage access that never throws (private mode, blocked storage, ...). */
export const sessionFlag = {
  get(key: string): boolean {
    try {
      return sessionStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  },
  set(key: string, on: boolean): void {
    try {
      if (on) sessionStorage.setItem(key, '1');
      else sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/**
 * After the matching engine was changed, the server switches in the background (the local neural model may first
 * download ~35 MB) and keeps reporting the previous engine until the new one is ready. True once the reported
 * status reflects the selected engine. For 'auto' the built-in engine is a valid outcome, so only the neural model
 * counts as settled; callers stop waiting after a time limit instead.
 */
export function embeddingSwitchSettled(selected: AppSettings['embeddings'], status: EmbedderStatus | null): boolean {
  if (!status || status.state === 'loading') return false;
  switch (selected.provider) {
    case 'builtin':
      return status.provider === 'builtin';
    case 'transformers':
      return status.provider === 'transformers';
    case 'ollama':
      return status.provider === 'ollama' && status.model === selected.ollamaModel;
    case 'auto':
      return status.provider === 'transformers';
  }
}
