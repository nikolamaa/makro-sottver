/**
 * Typed API client. Usage:
 *   const macros = await api('GET /api/macros');
 *   const m = await api('PUT /api/macros/:id', { params: { id }, body: input });
 * Every request carries the access token (see access.ts); a rejected token switches the UI to the access screen.
 */
import { API_ACCESS_DENIED, API_CLIENT_HEADER, type ApiReq, type ApiRes, type ApiRouteKey } from '../shared/api';
import { accessToken, markAccessDenied } from './access';

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function authHeaders(): Record<string, string> {
  const token = accessToken();
  return token ? { [API_CLIENT_HEADER]: token } : {};
}

function errorText(data: unknown, fallback: string): string {
  return data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : fallback;
}

function checkAccess(status: number, message: string): void {
  if (status === 403 && message === API_ACCESS_DENIED) markAccessDenied();
}

export interface ApiOptions<K extends ApiRouteKey> {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: ApiReq<K>;
  signal?: AbortSignal;
}

export async function api<K extends ApiRouteKey>(key: K, opts: ApiOptions<K> = {}): Promise<ApiRes<K>> {
  const [method, pathTemplate] = key.split(' ') as [string, string];
  let path = pathTemplate.replace(/:([A-Za-z_]+)/g, (_, name: string) => {
    const v = opts.params?.[name];
    if (v === undefined) throw new Error(`Missing path param ${name} for ${key}`);
    return encodeURIComponent(v);
  });
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    if (s) path += `?${s}`;
  }
  const headers = authHeaders();
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { method, headers, body, signal: opts.signal });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg = errorText(data, res.statusText);
    checkAccess(res.status, msg);
    throw new ApiClientError(msg, res.status);
  }
  return data as ApiRes<K>;
}

/** Download helper for GET endpoints that return files (export). */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    const msg = errorText(data, text || res.statusText);
    checkAccess(res.status, msg);
    throw new ApiClientError(msg, res.status);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
