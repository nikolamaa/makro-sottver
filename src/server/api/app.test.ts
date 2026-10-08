/**
 * End-to-end tests of the HTTP API against a real runtime (real crypto, SQLite file, search, personalization).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InjectOptions } from 'fastify';
import { API_ACCESS_DENIED, API_CLIENT_HEADER, type HealthResponse } from '../../shared/api.js';
import type { AppSettings, Macro, MacroVersion, PersonalizeResponse, RecommendResponse, RerankResponse, SecurityStatus } from '../../shared/types.js';
import { createRuntime, KeyMismatchError, type Runtime } from '../bootstrap.js';
import type { AppConfig } from '../config.js';
import { readBackup } from '../crypto/backup.js';
import { MacroIndex } from '../search/macroIndex.js';
import { deriveAccessToken } from '../services/security.js';

const PORT = 4999;
let dir: string;
let config: AppConfig;
let rt: Runtime;
let masterKeyB64: string;

function makeConfig(base: string, key: string): AppConfig {
  return {
    version: 'test',
    host: '127.0.0.1',
    port: PORT,
    dataDir: join(base, 'data'),
    keyDir: join(base, 'keys'),
    dbFile: join(base, 'data', 'macropilot.db'),
    modelCacheDir: join(base, 'data', 'models'),
    webDir: null,
    seedFile: null,
    openBrowser: false,
    seedOnFirstRun: false,
    envMasterKey: key,
    disableKeychain: true,
    isDev: false,
  };
}

async function call<T = unknown>(method: InjectOptions['method'], url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await rt.app.inject({
    method,
    url,
    payload: payload as InjectOptions['payload'],
    headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: rt.accessToken, ...headers },
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : undefined) as T, raw: res };
}

const WITHDRAWAL = {
  title: 'Crypto withdrawal still pending',
  body: 'Hi {{user}},\n\nThanks for your patience! Your {{crypto}} withdrawal is being processed. You can track it with the transaction hash once it is broadcast.\n\nLet me know if you need anything else.',
  categoryId: null,
  tags: ['crypto', 'withdrawal'],
  intents: ['withdrawal_pending'],
  triggers: ['my withdrawal is still pending', 'where is my btc cashout'],
  notes: '',
  shortcut: 'wd-pending',
  facts: [{ key: 'wd.track', statement: 'Withdrawals can be tracked with the tx hash', value: 'tx hash', sourceUrl: null, evidenceQuote: null }],
};
const PASSWORD = {
  title: 'Reset password',
  body: 'Hi {{user}},\n\nYou can reset your password from the login screen by clicking "Forgot password". The reset link is sent to {{email|your registered email}}.',
  categoryId: null,
  tags: ['account'],
  intents: ['account_access'],
  triggers: ['i forgot my password', 'cant log in'],
  notes: '',
  shortcut: 'pw',
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'macropilot-api-'));
  masterKeyB64 = randomBytes(32).toString('base64');
  config = makeConfig(dir, masterKeyB64);
  rt = await createRuntime(config);
  await rt.embedderReady;
});

afterAll(async () => {
  await rt.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Request without (or with the given) access token; never throws. */
async function raw(method: InjectOptions['method'], url: string, headers: Record<string, string> = {}, payload?: string) {
  return rt.app.inject({ method, url, payload, headers: { host: `localhost:${PORT}`, ...headers } });
}

describe('local API protection', () => {
  it('rejects API calls without the client header', async () => {
    const res = await rt.app.inject({ method: 'GET', url: '/api/macros', headers: { host: `127.0.0.1:${PORT}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: API_ACCESS_DENIED });
  });
  it('requires the per-install access token, not a constant header value', async () => {
    for (const value of ['1', '', 'x'.repeat(rt.accessToken.length), rt.accessToken.slice(1), `${rt.accessToken}x`]) {
      const res = await raw('GET', '/api/settings', { [API_CLIENT_HEADER]: value });
      expect(res.statusCode, value).toBe(403);
      expect(res.json()).toEqual({ error: API_ACCESS_DENIED });
    }
    expect((await raw('GET', '/api/settings', { [API_CLIENT_HEADER]: rt.accessToken })).statusCode).toBe(200);
  });
  it('derives the token from the master key (same link after a restart, different for another key)', () => {
    expect(rt.accessToken).toBe(deriveAccessToken(Buffer.from(masterKeyB64, 'base64')));
    expect(rt.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveAccessToken(randomBytes(32))).not.toBe(rt.accessToken);
  });
  it('cannot be bypassed with a percent-encoded /api path', async () => {
    const before = (await call<{ recoveryKey: string | null }>('GET', '/api/security/recovery-key')).body.recoveryKey;
    expect(before).toMatch(/^MPRK-/);
    for (const url of ['/%61pi/settings', '/%61pi/export?format=json', '/%61%70%69/security/recovery-key', '/%2561pi/settings', '/%E0%A4%A/api']) {
      const res = await raw('GET', url);
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain('MPRK-');
      expect(res.headers['content-disposition'], url).toBeUndefined();
    }
    for (const url of ['/%61pi/security/recovery-key/ack', '/%61pi/security/recovery-key/rotate', '/%61pi/ai/test']) {
      const plain = await raw('POST', url, { 'content-type': 'text/plain' }, 'x');
      expect(plain.statusCode, url).toBe(403);
      const foreign = await raw('POST', url, { 'content-type': 'text/plain', origin: 'https://evil.example', [API_CLIENT_HEADER]: rt.accessToken }, 'x');
      expect(foreign.statusCode, url).toBe(403);
      expect(foreign.json()).toEqual({ error: 'Forbidden origin' });
    }
    const status = await call<SecurityStatus>('GET', '/api/security/status');
    expect(status.body.recoveryKeyAcknowledged).toBe(false);
    expect((await call<{ recoveryKey: string | null }>('GET', '/api/security/recovery-key')).body.recoveryKey).toBe(before);
  });
  it('treats a percent-encoded API path as API for caching too', async () => {
    const res = await raw('GET', '/%61pi/health', { [API_CLIENT_HEADER]: rt.accessToken });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const res = await call('GET', '/api/macros', undefined, { host: 'evil.example:4999' });
    expect(res.status).toBe(403);
  });
  it('rejects foreign origins', async () => {
    const res = await call('GET', '/api/macros', undefined, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });
  it('sets security headers', async () => {
    const res = await rt.app.inject({ method: 'GET', url: '/', headers: { host: `localhost:${PORT}` } });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

describe('macro lifecycle + assist flow', () => {
  let wd: Macro;
  let pw: Macro;

  it('creates macros', async () => {
    const a = await call<Macro>('POST', '/api/macros', WITHDRAWAL);
    expect(a.status).toBe(200);
    wd = a.body;
    expect(wd.version).toBe(1);
    expect(wd.facts).toHaveLength(1);
    const b = await call<Macro>('POST', '/api/macros', PASSWORD);
    pw = b.body;
    const list = await call<Macro[]>('GET', '/api/macros');
    expect(list.body.map((m) => m.title).sort()).toEqual([PASSWORD.title, WITHDRAWAL.title].sort());
  });

  it('validates input', async () => {
    const res = await call('POST', '/api/macros', { ...WITHDRAWAL, title: '   ' });
    expect(res.status).toBe(400);
  });

  it('recommends the right macro quickly', async () => {
    const res = await call<RecommendResponse>('POST', '/api/recommend', { message: 'Hey, my BTC withdrawal has been pending for 2 days, where is it??' });
    expect(res.status).toBe(200);
    expect(res.body.recommendations[0]?.macroId).toBe(wd.id);
    expect(res.body.analysis.intents[0]?.intent).toBe('withdrawal_pending');
    expect(res.body.timingMs.total).toBeLessThan(200);
  });

  it('AI double-check falls back to the local recommendations when AI is off', async () => {
    const message = 'Hey, my BTC withdrawal has been pending for 2 days, where is it??';
    const local = await call<RecommendResponse>('POST', '/api/recommend', { message });
    const res = await call<RerankResponse>('POST', '/api/rerank', { message });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recommendations: local.body.recommendations, noGoodMatch: local.body.noGoodMatch, aiUsed: false, llm: null });
    expect(res.body.recommendations[0]?.macroId).toBe(wd.id);

    expect((await call<RerankResponse>('POST', '/api/rerank', { message: '   ' })).body).toEqual({ recommendations: [], noGoodMatch: false, aiUsed: false, llm: null });
    expect((await call('POST', '/api/rerank', {})).status).toBe(400);
    expect((await call('POST', '/api/rerank', { message: 42 })).status).toBe(400);
    expect((await call('POST', '/api/rerank', { message: 'x'.repeat(9000) })).status).toBe(400);
  });

  it('stores the AI double-check setting (default on)', async () => {
    expect((await call<AppSettings>('GET', '/api/settings')).body.ai.rerank).toBe(true);
    expect((await call<AppSettings>('PUT', '/api/settings', { ai: { rerank: false } })).body.ai.rerank).toBe(false);
    expect((await call<AppSettings>('PUT', '/api/settings', { ai: { rerank: 'yes' } })).body.ai.rerank).toBe(false);
    expect((await call<AppSettings>('PUT', '/api/settings', { ai: { rerank: true } })).body.ai.rerank).toBe(true);
  });

  it('personalizes in fast mode', async () => {
    const res = await call<PersonalizeResponse>('POST', '/api/personalize', {
      message: 'my btc withdrawal is pending',
      macroIds: [wd.id],
      variables: { user: 'Marko' },
      mode: 'fast',
    });
    expect(res.status).toBe(200);
    expect(res.body.text).toContain('Hi Marko,');
    expect(res.body.text).toContain('BTC');
    expect(res.body.mode).toBe('fast');
  });

  it('combines two macros', async () => {
    const res = await call<PersonalizeResponse>('POST', '/api/personalize', {
      message: 'my withdrawal is pending and also I forgot my password',
      macroIds: [wd.id, pw.id],
      mode: 'fast',
    });
    expect(res.status).toBe(200);
    expect(res.body.text.match(/^Hi /gm)?.length).toBe(1);
    expect(res.body.text).toContain('Forgot password');
  });

  it('returns 400 for AI mode when AI is off', async () => {
    const res = await call('POST', '/api/personalize', { message: 'x', macroIds: [wd.id], mode: 'ai' });
    expect(res.status).toBe(400);
  });

  it('drafts a reply skeleton without AI', async () => {
    const res = await call<{ text: string }>('POST', '/api/draft', { message: 'Do you sponsor football teams?' });
    expect(res.status).toBe(200);
    expect(res.body.text).toContain('[ENTER ANSWER ABOUT');
  });

  it('counts usage when a reply is copied', async () => {
    await call('POST', '/api/events', { type: 'reply_copied', macroIds: [wd.id], editRatio: 0.1, mode: 'fast', rank: 0 });
    const res = await call<Macro>('GET', `/api/macros/${wd.id}`);
    expect(res.body.useCount).toBe(1);
  });

  it('versions and reverts', async () => {
    const upd = await call<Macro>('PUT', `/api/macros/${wd.id}`, { ...WITHDRAWAL, body: `${WITHDRAWAL.body}\nExtra line.` });
    expect(upd.body.version).toBe(2);
    const versions = await call<MacroVersion[]>('GET', `/api/macros/${wd.id}/versions`);
    expect(versions.body.map((v) => v.version)).toEqual([2, 1]);
    const rev = await call<Macro>('POST', `/api/macros/${wd.id}/revert`, { version: 1 });
    expect(rev.body.version).toBe(3);
    expect(rev.body.body).toBe(WITHDRAWAL.body);
  });

  it('archives, hides and restores', async () => {
    expect((await call('DELETE', `/api/macros/${pw.id}`)).status).toBe(200);
    expect((await call<Macro[]>('GET', '/api/macros')).body.some((m) => m.id === pw.id)).toBe(false);
    expect((await call<Macro[]>('GET', '/api/macros?archived=1')).body.some((m) => m.id === pw.id)).toBe(true);
    const restored = await call<Macro>('POST', `/api/macros/${pw.id}/restore`);
    expect(restored.body.archivedAt).toBeNull();
  });

  it('returns 404 for unknown macros and endpoints', async () => {
    expect((await call('GET', '/api/macros/does-not-exist')).status).toBe(404);
    expect((await call('GET', '/api/nope')).status).toBe(404);
  });
});

describe('import / export / security', () => {
  it('imports the manual Intercom text format', async () => {
    const content = '### KYC documents\nCategory: Verification\nTags: kyc\nIntents: kyc_verification\nHi {{first_name | fallback: "there"}},\nPlease upload a clear photo of your {{document_type}}.\n---\n### Self exclusion\nIntents: responsible_gambling\nHi {{first_name}}, we can set up a self-exclusion for you.';
    const preview = await call<{ items: { title: string; body: string }[]; errors: string[] }>('POST', '/api/import/preview', { format: 'text', content });
    expect(preview.status).toBe(200);
    expect(preview.body.items).toHaveLength(2);
    expect(preview.body.items[0]?.body).toContain('{{user|there}}');
    const commit = await call<{ created: number }>('POST', '/api/import/commit', { items: preview.body.items, onDuplicate: 'skip' });
    expect(commit.body.created).toBe(2);
    const again = await call<{ skipped: number }>('POST', '/api/import/commit', { items: preview.body.items, onDuplicate: 'skip' });
    expect(again.body.skipped).toBe(2);
  });

  it('exports plain JSON and an encrypted backup that opens only with the recovery key', async () => {
    const json = await rt.app.inject({ method: 'GET', url: '/api/export?format=json', headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: rt.accessToken } });
    expect(json.statusCode).toBe(200);
    expect(json.body).toContain('Crypto withdrawal still pending');

    const { body } = await call<{ recoveryKey: string | null }>('GET', '/api/security/recovery-key');
    expect(body.recoveryKey).toMatch(/^MPRK-/);
    const backup = await rt.app.inject({ method: 'GET', url: '/api/export?format=backup', headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: rt.accessToken } });
    expect(backup.statusCode).toBe(200);
    expect(backup.body).not.toContain('Crypto withdrawal still pending');
    const restored = readBackup<{ library: { macros: { title: string }[] } }>(backup.rawPayload, body.recoveryKey!);
    expect(restored.payload.library.macros.some((m) => m.title === 'Crypto withdrawal still pending')).toBe(true);

    const ack = await call<{ recoveryKeyAcknowledged: boolean }>('POST', '/api/security/recovery-key/ack');
    expect(ack.body.recoveryKeyAcknowledged).toBe(true);
    expect((await call<{ recoveryKey: string | null }>('GET', '/api/security/recovery-key')).body.recoveryKey).toBeNull();
  });

  it('never returns the API key and clamps settings', async () => {
    await call('PUT', '/api/settings/anthropic-key', { apiKey: 'sk-ant-test-1234567890' });
    const s = await call<Record<string, unknown>>('PUT', '/api/settings', { recommendation: { maxResults: 99 } });
    expect(JSON.stringify(s.body)).not.toContain('sk-ant-test');
    expect((s.body as { recommendation: { maxResults: number } }).recommendation.maxResults).toBe(3);
    expect((s.body as { ai: { anthropicKeySet: boolean } }).ai.anthropicKeySet).toBe(true);
  });

  it('stores nothing in plaintext on disk', () => {
    const files = readdirSync(config.dataDir).filter((f) => f.startsWith('macropilot.db'));
    const bytes = Buffer.concat(files.map((f) => readFileSync(join(config.dataDir, f))));
    const haystack = bytes.toString('latin1');
    for (const needle of ['Crypto withdrawal', 'Forgot password', 'KYC documents', 'sk-ant-test', 'MPRK-', 'tx hash']) {
      expect(haystack.includes(needle), needle).toBe(false);
    }
  });

  it('refuses to open the database with a different key', async () => {
    const other = makeConfig(dir, randomBytes(32).toString('base64'));
    await expect(createRuntime(other)).rejects.toBeInstanceOf(KeyMismatchError);
  });
});

describe('backup restore', () => {
  it('opens a backup with the recovery key and previews its macros; rejects a wrong key', async () => {
    const rotated = await call<{ recoveryKey: string }>('POST', '/api/security/recovery-key/rotate');
    const backup = await rt.app.inject({ method: 'GET', url: '/api/export?format=backup', headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: rt.accessToken } });
    const ok = await call<{ items: { title: string; duplicateOf: string | null }[] }>('POST', '/api/import/backup', {
      backup: backup.body,
      recoveryKey: rotated.body.recoveryKey.toLowerCase(),
    });
    expect(ok.status).toBe(200);
    const wd = ok.body.items.find((i) => i.title === 'Crypto withdrawal still pending');
    expect(wd?.duplicateOf).toBeTruthy();
    const bad = await call<{ error: string }>('POST', '/api/import/backup', { backup: backup.body, recoveryKey: 'MPRK-0000-0000-0000-0000-0000-0000-0000-0000' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/recovery key/i);
  });

  it('restores archived macros, favorites and category colors over HTTP', async () => {
    const base = mkdtempSync(join(tmpdir(), 'macropilot-restore-'));
    const source = await createRuntime(makeConfig(join(base, 'source'), randomBytes(32).toString('base64')));
    const target = await createRuntime(makeConfig(join(base, 'target'), randomBytes(32).toString('base64')));
    const req = async <T>(r: Runtime, method: InjectOptions['method'], url: string, payload?: unknown) => {
      const res = await r.app.inject({
        method,
        url,
        payload: payload as InjectOptions['payload'],
        headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: r.accessToken },
      });
      expect(res.statusCode).toBe(200);
      return { json: () => res.json() as T, body: res.body };
    };
    try {
      await Promise.all([source.embedderReady, target.embedderReady]);
      const cat = (await req<{ id: string }>(source, 'POST', '/api/categories', { name: 'Payments', color: '#12ab34' })).json();
      const fav = (await req<Macro>(source, 'POST', '/api/macros', { ...WITHDRAWAL, categoryId: cat.id })).json();
      await req(source, 'POST', `/api/macros/${fav.id}/favorite`, { favorite: true });
      const old = (await req<Macro>(source, 'POST', '/api/macros', PASSWORD)).json();
      await req(source, 'DELETE', `/api/macros/${old.id}`);
      const recoveryKey = (await req<{ recoveryKey: string }>(source, 'POST', '/api/security/recovery-key/rotate')).json().recoveryKey;
      const backup = (await req(source, 'GET', '/api/export?format=backup')).body;

      const preview = (await req<{ items: unknown[] }>(target, 'POST', '/api/import/backup', { backup, recoveryKey })).json();
      await req(target, 'POST', '/api/import/commit', { items: preview.items, onDuplicate: 'skip' });
      const restored = (await req<Macro[]>(target, 'GET', '/api/macros?archived=1')).json();
      expect(restored.find((m) => m.title === WITHDRAWAL.title)?.isFavorite).toBe(true);
      expect(restored.find((m) => m.title === PASSWORD.title)?.archivedAt).toBeTruthy();
      const cats = (await req<{ name: string; color: string }[]>(target, 'GET', '/api/categories')).json();
      expect(cats.find((c) => c.name === 'Payments')?.color).toBe('#12ab34');
    } finally {
      await source.close();
      await target.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('recovery key rotation', () => {
  it('keeps the new key pending (shown again) until it is acknowledged', async () => {
    const rotated = await call<{ recoveryKey: string }>('POST', '/api/security/recovery-key/rotate');
    expect(rotated.status).toBe(200);
    expect(rotated.body.recoveryKey).toMatch(/^MPRK-/);
    expect((await call<SecurityStatus>('GET', '/api/security/status')).body.recoveryKeyAcknowledged).toBe(false);
    // A closed tab or a lost response does not lose the key: it is served again until confirmed.
    expect((await call<{ recoveryKey: string | null }>('GET', '/api/security/recovery-key')).body.recoveryKey).toBe(rotated.body.recoveryKey);

    // New backups already use the new key.
    const backup = await rt.app.inject({ method: 'GET', url: '/api/export?format=backup', headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: rt.accessToken } });
    expect(readBackup(backup.rawPayload, rotated.body.recoveryKey).payload).toBeTruthy();

    // The pending key is stored encrypted.
    const files = readdirSync(config.dataDir).filter((f) => f.startsWith('macropilot.db'));
    const haystack = Buffer.concat(files.map((f) => readFileSync(join(config.dataDir, f)))).toString('latin1');
    expect(haystack.includes(rotated.body.recoveryKey)).toBe(false);

    const ack = await call<SecurityStatus>('POST', '/api/security/recovery-key/ack');
    expect(ack.body.recoveryKeyAcknowledged).toBe(true);
    expect((await call<{ recoveryKey: string | null }>('GET', '/api/security/recovery-key')).body.recoveryKey).toBeNull();
  });
});

describe('large imports', () => {
  const MB = 1024 * 1024;

  it('accepts import previews and commits larger than the default 3 MB request limit', async () => {
    const macro = (i: number) => `### Large import macro ${i}\nHi {{user}}, ${'this is a long answer. '.repeat(120)}\n---\n`;
    let content = '';
    for (let i = 0; content.length < 4 * MB; i++) content += macro(i);
    const preview = await call<{ items: unknown[]; errors: string[] }>('POST', '/api/import/preview', { format: 'text', content });
    expect(preview.status).toBe(200);
    expect(Array.isArray(preview.body.items)).toBe(true);

    const commit = await call<{ created: number }>('POST', '/api/import/commit', { items: [], onDuplicate: 'skip', padding: 'x'.repeat(4 * MB) });
    expect(commit.status).toBe(200);
  });

  it('still bounds the preview content (30 MB)', async () => {
    const res = await call<{ error: string }>('POST', '/api/import/preview', { format: 'text', content: 'x'.repeat(30 * MB + 1) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^content:/);
  });
});

describe('search embedder selection', () => {
  it('never uses an Ollama on another computer for embeddings, and shows why without re-indexing', async () => {
    const before = (await call<AppSettings>('GET', '/api/settings')).body;
    // Start from the plain builtin embedder (whatever 'auto' resolved to on this machine).
    await call('PUT', '/api/settings', { embeddings: { provider: 'builtin' } });
    await vi.waitFor(async () => {
      const h = await call<HealthResponse>('GET', '/api/health');
      expect(h.body.embeddings.provider).toBe('builtin');
      expect(h.body.embeddings.detail).toMatch(/^Built-in/);
    });
    const setEmbedder = vi.spyOn(MacroIndex.prototype, 'setEmbedder');
    try {
      await call('PUT', '/api/settings', {
        privacy: { strictLocal: true },
        ai: { ollamaUrl: 'http://192.168.1.20:11434' },
        embeddings: { provider: 'ollama' },
      });
      await vi.waitFor(async () => {
        const h = await call<HealthResponse>('GET', '/api/health');
        expect(h.body.embeddings.detail).toMatch(/only used with a local Ollama \(localhost\)/);
      });
      const h = await call<HealthResponse>('GET', '/api/health');
      expect(h.body.embeddings.provider).toBe('builtin');
      expect(h.body.embeddings.state).toBe('ready');
      expect(setEmbedder).not.toHaveBeenCalled();
      const rec = await call<RecommendResponse>('POST', '/api/recommend', { message: 'my btc withdrawal is pending, email john.doe@example.com' });
      expect(rec.status).toBe(200);
    } finally {
      setEmbedder.mockRestore();
      await call('PUT', '/api/settings', { privacy: before.privacy, ai: { ollamaUrl: before.ai.ollamaUrl }, embeddings: before.embeddings });
    }
  });

  it('indexes the library only once at startup when the preferred embedder is builtin', async () => {
    const base = mkdtempSync(join(tmpdir(), 'macropilot-startup-'));
    const cfg = makeConfig(base, randomBytes(32).toString('base64'));
    try {
      const first = await createRuntime(cfg);
      await first.embedderReady;
      const put = await first.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { embeddings: { provider: 'builtin' } },
        headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: first.accessToken },
      });
      expect(put.statusCode).toBe(200);
      await first.close();

      const setEmbedder = vi.spyOn(MacroIndex.prototype, 'setEmbedder');
      try {
        const second = await createRuntime(cfg);
        await second.embedderReady;
        expect(setEmbedder).not.toHaveBeenCalled();
        expect(second.accessToken).toBe(first.accessToken);
        const health = await second.app.inject({
          method: 'GET',
          url: '/api/health',
          headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: second.accessToken },
        });
        expect((health.json() as HealthResponse).embeddings.provider).toBe('builtin');
        await second.close();
      } finally {
        setEmbedder.mockRestore();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
