import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_ACCESS_DENIED, API_CLIENT_HEADER } from '../shared/api';
import { ACCESS_STORAGE_KEY, accessToken, initAccess, isAccessDenied, takeTokenFromHash } from './access';
import { api, downloadFile } from './api';

const TOKEN = 'Ab3_-xYz0123456789abcdefghijklmnopqrstuvwxy';

function stubBrowser(hash: string, stored: string | null = null) {
  const storage = new Map<string, string>(stored ? [[ACCESS_STORAGE_KEY, stored]] : []);
  const loc = { pathname: '/', search: '', hash };
  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => {
    loc.hash = url.slice(url.indexOf('#'));
  });
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', { state: null, replaceState });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  });
  return { storage, loc, replaceState };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('takeTokenFromHash', () => {
  it('takes k out of the launcher link and keeps the route', () => {
    expect(takeTokenFromHash(`#/assist?k=${TOKEN}`)).toEqual({ token: TOKEN, hash: '#/assist' });
    expect(takeTokenFromHash(`#/settings?x=1&k=${TOKEN}`)).toEqual({ token: TOKEN, hash: '#/settings?x=1' });
    expect(takeTokenFromHash(`#?k=${TOKEN}`)).toEqual({ token: TOKEN, hash: '#' });
  });
  it('leaves other hashes alone and rejects malformed tokens', () => {
    expect(takeTokenFromHash('#/library')).toEqual({ token: null, hash: '#/library' });
    expect(takeTokenFromHash('')).toEqual({ token: null, hash: '' });
    expect(takeTokenFromHash('#/assist?k=<script>')).toEqual({ token: null, hash: '#/assist' });
  });
});

describe('initAccess', () => {
  it('stores the token from the URL and removes it from the address bar', () => {
    const b = stubBrowser(`#/assist?k=${TOKEN}`);
    initAccess();
    expect(accessToken()).toBe(TOKEN);
    expect(b.storage.get(ACCESS_STORAGE_KEY)).toBe(TOKEN);
    expect(b.replaceState).toHaveBeenCalledWith(null, '', '/#/assist');
    expect(b.loc.hash).toBe('#/assist');
  });
  it('uses the remembered token when the URL has none', () => {
    const b = stubBrowser('#/library', TOKEN);
    initAccess();
    expect(accessToken()).toBe(TOKEN);
    expect(b.replaceState).not.toHaveBeenCalled();
  });
  it('a new launcher link replaces an old remembered token', () => {
    const b = stubBrowser(`#/assist?k=${TOKEN}`, 'old-token-old-token-old');
    initAccess();
    expect(accessToken()).toBe(TOKEN);
    expect(b.storage.get(ACCESS_STORAGE_KEY)).toBe(TOKEN);
  });
  it('works when storage is blocked', () => {
    stubBrowser(`#/assist?k=${TOKEN}`);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    initAccess();
    expect(accessToken()).toBe(TOKEN);
  });
});

describe('API client', () => {
  it('sends the access token and reports a rejected token', async () => {
    stubBrowser(`#/assist?k=${TOKEN}`);
    initAccess();
    const seen: Record<string, string>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return seen.length === 1
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response(JSON.stringify({ error: API_ACCESS_DENIED }), { status: 403 });
      }),
    );
    await api('POST /api/security/recovery-key/ack');
    expect(seen[0]?.[API_CLIENT_HEADER]).toBe(TOKEN);
    expect(isAccessDenied()).toBe(false);
    await expect(downloadFile('/api/export?format=json', 'x.json')).rejects.toThrow(API_ACCESS_DENIED);
    expect(seen[1]?.[API_CLIENT_HEADER]).toBe(TOKEN);
    expect(isAccessDenied()).toBe(true);
  });
});
