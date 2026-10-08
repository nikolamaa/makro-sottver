/**
 * End-to-end tests of the HTTP API against a real runtime (real crypto, SQLite file, search, personalization).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { API_CLIENT_HEADER } from '../../shared/api.js';
import type { Macro, MacroVersion, PersonalizeResponse, RecommendResponse } from '../../shared/types.js';
import { createRuntime, KeyMismatchError, type Runtime } from '../bootstrap.js';
import type { AppConfig } from '../config.js';
import { readBackup } from '../crypto/backup.js';

const PORT = 4999;
let dir: string;
let config: AppConfig;
let rt: Runtime;

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
    headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: '1', ...headers },
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
  config = makeConfig(dir, randomBytes(32).toString('base64'));
  rt = await createRuntime(config);
  await rt.embedderReady;
});

afterAll(async () => {
  await rt.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('local API protection', () => {
  it('rejects API calls without the client header', async () => {
    const res = await rt.app.inject({ method: 'GET', url: '/api/macros', headers: { host: `127.0.0.1:${PORT}` } });
    expect(res.statusCode).toBe(403);
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
    const json = await rt.app.inject({ method: 'GET', url: '/api/export?format=json', headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: '1' } });
    expect(json.statusCode).toBe(200);
    expect(json.body).toContain('Crypto withdrawal still pending');

    const { body } = await call<{ recoveryKey: string | null }>('GET', '/api/security/recovery-key');
    expect(body.recoveryKey).toMatch(/^MPRK-/);
    const backup = await rt.app.inject({ method: 'GET', url: '/api/export?format=backup', headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: '1' } });
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
    const backup = await rt.app.inject({ method: 'GET', url: '/api/export?format=backup', headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: '1' } });
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
});
