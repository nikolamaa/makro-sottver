/**
 * POST /api/rerank (AI double-check of recommendations) against a real runtime with a fake LLM provider:
 * fallbacks, settings, budget, strict local mode, pseudonymization and usage accounting.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InjectOptions } from 'fastify';
import type { z } from 'zod';
import { API_CLIENT_HEADER, type HealthResponse } from '../../shared/api.js';
import type { AppSettings, DeepPartial, LlmUsage, Macro, RecommendResponse, RerankResponse, UsageSummary } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../shared/types.js';
import { AiError, type JsonRequest, type LlmProvider } from '../ai/provider.js';
import { createRuntime, type Runtime } from '../bootstrap.js';
import type { AppConfig } from '../config.js';

const PORT = 4998;
const USAGE: LlmUsage = { provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 1800, outputTokens: 300, costUsd: 0.0003, latencyMs: 700 };
const MESSAGE = 'Hi, my name is John Smith (john.smith@example.com). My BTC withdrawal has been pending for 2 days, where is it?';

type Ranked = { id: string; confidence: number; reason: string }[];

/**
 * Fake Claude: records requests; `answer` ranks the candidate ids found in the prompt (or throws `error`). With
 * `delayMs` it answers late and, like the real providers, fails with AiError('cancelled') when the call is aborted.
 */
const fake = {
  requests: [] as JsonRequest<z.ZodType>[],
  answer: (ids: string[]): Ranked => ids.map((id, i) => ({ id, confidence: 90 - i * 20, reason: `AI reason ${i}` })),
  error: null as AiError | null,
  delayMs: 0,
  cancelled: 0,
};

function waitOrCancel(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        fake.cancelled++;
        reject(new AiError('cancelled', 'The AI request was cancelled.'));
      },
      { once: true },
    );
  });
}

const provider: LlmProvider = {
  id: 'anthropic',
  model: 'claude-haiku-5-5',
  isCloud: true,
  async generateJson<S extends z.ZodType>(req: JsonRequest<S>) {
    fake.requests.push(req);
    if (fake.delayMs) await waitOrCancel(fake.delayMs, req.signal);
    if (fake.error) throw fake.error;
    const ids = [...req.user.matchAll(/<candidate id="([^"]+)">/g)].map((m) => m[1]!);
    const data = req.schema.parse({ ranked: fake.answer(ids), no_good_match: false, missing_topics: [] }) as z.infer<S>;
    return { data, usage: USAGE };
  },
  test: async () => ({ ok: true, detail: 'fake' }),
};

const macro = (title: string, intents: string[], triggers: string[], body: string) => ({
  title,
  body,
  categoryId: null,
  tags: [],
  intents,
  triggers,
  notes: '',
  shortcut: '',
});

const MACROS = [
  macro('Crypto withdrawal still pending', ['withdrawal_pending'], ['my withdrawal is still pending', 'where is my btc cashout'], 'Hi {{user}},\n\nYour {{crypto}} withdrawal is being processed.'),
  macro('Withdrawal not received after confirmation', ['withdrawal_pending'], ['withdrawal confirmed but not in my wallet'], 'Hi {{user}},\n\nPlease share the transaction hash so we can check the withdrawal.'),
  macro('How to withdraw crypto', ['withdrawal_help'], ['how do i withdraw btc', 'how to cash out'], 'Hi {{user}},\n\nGo to Wallet > Withdraw, choose the currency and paste your address.'),
  macro('Withdrawal limits', ['withdrawal_limits'], ['what is the minimum withdrawal'], 'Hi {{user}},\n\nWithdrawal limits depend on the currency.'),
  macro('Deposit not credited', ['deposit_missing'], ['my deposit has not arrived'], 'Hi {{user}},\n\nDeposits are credited after network confirmations.'),
];

let dir: string;
let rt: Runtime;

async function call<T = unknown>(method: InjectOptions['method'], url: string, payload?: unknown) {
  const res = await rt.app.inject({
    method,
    url,
    payload: payload as InjectOptions['payload'],
    headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: rt.accessToken },
  });
  return { status: res.statusCode, body: JSON.parse(res.body) as T };
}

const rerank = (message = MESSAGE) => call<RerankResponse>('POST', '/api/rerank', { message });
const settings = (patch: DeepPartial<AppSettings>) => call<AppSettings>('PUT', '/api/settings', patch);
const usage = async () => (await call<UsageSummary>('GET', '/api/usage')).body;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'macropilot-rerank-'));
  const config: AppConfig = {
    version: 'test',
    host: '127.0.0.1',
    port: PORT,
    dataDir: join(dir, 'data'),
    keyDir: join(dir, 'keys'),
    dbFile: join(dir, 'data', 'macropilot.db'),
    modelCacheDir: join(dir, 'data', 'models'),
    webDir: null,
    seedFile: null,
    openBrowser: false,
    seedOnFirstRun: false,
    envMasterKey: randomBytes(32).toString('base64'),
    disableKeychain: true,
    isDev: false,
  };
  rt = await createRuntime(config, () => {}, { aiProviderFactory: (s) => (s.ai.provider === 'none' ? null : provider) });
  await rt.embedderReady;
  for (const m of MACROS) expect((await call<Macro>('POST', '/api/macros', m)).status).toBe(200);
});

afterAll(async () => {
  await rt.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  fake.requests = [];
  fake.error = null;
  fake.delayMs = 0;
  fake.cancelled = 0;
  fake.answer = (ids) => ids.map((id, i) => ({ id, confidence: 90 - i * 20, reason: `AI reason ${i}` }));
  await settings({ ai: { provider: 'anthropic', rerank: true, monthlyBudgetUsd: 5, pseudonymize: true }, privacy: { strictLocal: false }, recommendation: DEFAULT_SETTINGS.recommendation });
});

describe('POST /api/rerank', () => {
  it('returns the local result without calling the AI when no provider is set', async () => {
    await settings({ ai: { provider: 'none' } });
    const local = await call<RecommendResponse>('POST', '/api/recommend', { message: MESSAGE });
    const res = await rerank();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recommendations: local.body.recommendations, noGoodMatch: local.body.noGoodMatch, aiUsed: false, llm: null });
    expect(fake.requests).toHaveLength(0);
  });

  it('re-scores up to 8 local candidates, returns the best maxResults and records usage', async () => {
    const before = await usage();
    const local = (await call<RecommendResponse>('POST', '/api/recommend', { message: MESSAGE })).body.recommendations;
    // The AI prefers the local #2.
    fake.answer = (ids) => {
      const order = [ids[1]!, ids[0]!, ...ids.slice(2)];
      return order.map((id, i) => ({ id, confidence: 91 - i * 15, reason: `AI: fits for ⟦NAME_1⟧ #${i}` }));
    };
    const res = await rerank();

    expect(res.status).toBe(200);
    expect(res.body.aiUsed).toBe(true);
    expect(res.body.llm).toEqual(USAGE);
    expect(res.body.noGoodMatch).toBe(false);
    expect(res.body.recommendations).toHaveLength(3);
    expect(res.body.recommendations.map((r) => r.macroId).slice(0, 2)).toEqual([local[1]!.macroId, local[0]!.macroId]);
    expect(res.body.recommendations[0]).toMatchObject({ confidence: 91, reason: 'AI: fits for John Smith #0', breakdown: local[1]!.breakdown });

    const req = fake.requests[0]!;
    expect(req.purpose).toBe('rerank');
    const candidates = req.user.match(/<candidate id=/g)?.length ?? 0;
    expect(candidates).toBeGreaterThan(3);
    expect(candidates).toBeLessThanOrEqual(8);
    expect(req.user).not.toContain('john.smith@example.com');
    expect(req.user).not.toContain('John Smith');

    const after = await usage();
    expect(after.requests).toBe(before.requests + 1);
    expect(after.costUsd).toBeCloseTo(before.costUsd + USAGE.costUsd, 8);
  });

  it('honours maxResults and reports noGoodMatch from the AI confidence', async () => {
    await settings({ recommendation: { maxResults: 1, minConfidence: 50 } });
    fake.answer = (ids) => ids.map((id, i) => ({ id, confidence: 40 - i, reason: 'Only partly relevant.' }));
    const res = await rerank();
    expect(res.body.aiUsed).toBe(true);
    expect(res.body.recommendations).toHaveLength(1);
    expect(res.body.recommendations[0]!.confidence).toBe(40);
    expect(res.body.noGoodMatch).toBe(true);
  });

  it('does not call the AI when the double-check is turned off', async () => {
    await settings({ ai: { rerank: false } });
    const res = await rerank();
    expect(res.body).toMatchObject({ aiUsed: false, llm: null });
    expect(res.body.recommendations.length).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('respects strict local mode and the monthly budget', async () => {
    await settings({ privacy: { strictLocal: true } });
    expect((await call<HealthResponse>('GET', '/api/health')).body.ai.ready).toBe(false);
    expect((await rerank()).body.aiUsed).toBe(false);

    await settings({ privacy: { strictLocal: false }, ai: { monthlyBudgetUsd: 0.0001 } });
    expect((await usage()).costUsd).toBeGreaterThan(0.0001);
    expect((await rerank()).body.aiUsed).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it('pseudonymizes self-introduced names, IBANs, cards, dates of birth, documents and addresses', async () => {
    const message =
      "Hi, I'm Jovana Petrovic. My BTC withdrawal has been pending for 2 days, where is it? My DOB is 14/03/1991. " +
      'Send it to IBAN DE89370400440532013000 or card 4111 1111 1111 1111. ' +
      'For KYC: 221B Baker Street, London NW1 6XE, passport no. X1234567.';
    fake.answer = (ids) => ids.map((id, i) => ({ id, confidence: 90 - i * 10, reason: `For ⟦NAME_1⟧, born ⟦DOB_1⟧ #${i}` }));
    const res = await rerank(message);
    expect(res.body.aiUsed).toBe(true);
    const user = fake.requests[0]!.user;
    for (const secret of ['Jovana', 'Petrovic', '14/03/1991', 'DE89370400440532013000', '4111 1111 1111 1111', 'Baker Street', 'NW1 6XE', 'X1234567']) {
      expect(user).not.toContain(secret);
    }
    expect(user).toContain('BTC withdrawal has been pending for 2 days');
    expect(res.body.recommendations[0]!.reason).toBe('For Jovana Petrovic, born 14/03/1991 #0');
  });

  it('pseudonymizes the agent-entered variables (customer name) the detectors cannot find', async () => {
    const message = 'hello, jovana writing again. Jovana is the name on my account, my BTC withdrawal has been pending for 2 days';
    fake.answer = (ids) => ids.map((id, i) => ({ id, confidence: 90 - i * 10, reason: `Fits ⟦NAME_1⟧ #${i}` }));
    const res = await call<RerankResponse>('POST', '/api/rerank', { message, variables: { user: 'Jovana', eta_time: '24 hours' } });
    expect(res.status).toBe(200);
    expect(res.body.aiUsed).toBe(true);
    expect(fake.requests[0]!.user).not.toContain('Jovana');
    expect(fake.requests[0]!.user).toContain('⟦NAME_1⟧ is the name on my account');
    expect(res.body.recommendations[0]!.reason).toBe('Fits Jovana #0');
  });

  it('sends the message as is when pseudonymization is off', async () => {
    await settings({ ai: { pseudonymize: false } });
    await rerank();
    expect(fake.requests[0]!.user).toContain('john.smith@example.com');
  });

  it('falls back to the local result when the AI fails, still counting billed tokens', async () => {
    const local = (await call<RecommendResponse>('POST', '/api/recommend', { message: MESSAGE })).body;
    fake.error = new AiError('network', 'Cannot reach the Anthropic API.');
    const failed = await rerank();
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual({ recommendations: local.recommendations, noGoodMatch: local.noGoodMatch, aiUsed: false, llm: null });

    const before = await usage();
    fake.error = new AiError('invalid_output', 'Cut off.', USAGE);
    expect((await rerank()).body.aiUsed).toBe(false);
    expect((await usage()).requests).toBe(before.requests + 1);
  });
});

describe('POST /api/rerank over a real connection', () => {
  let port: number;

  beforeAll(async () => {
    await rt.app.listen({ port: 0, host: '127.0.0.1' });
    port = (rt.app.server.address() as AddressInfo).port;
  });

  /** Raw HTTP request (like the browser's fetch), so the test can drop the connection like an AbortController. */
  function post(message: string): { req: ClientRequest; body: Promise<RerankResponse> } {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/rerank',
      method: 'POST',
      headers: { host: `127.0.0.1:${PORT}`, [API_CLIENT_HEADER]: rt.accessToken, 'content-type': 'application/json' },
    });
    const body = new Promise<RerankResponse>((resolve, reject) => {
      req.on('error', reject);
      req.on('response', (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve(JSON.parse(data) as RerankResponse));
      });
    });
    req.end(JSON.stringify({ message }));
    return { req, body };
  }

  it('lets the AI finish while the browser waits for the answer', async () => {
    fake.delayMs = 60;
    const res = await post(MESSAGE).body;
    expect(res.aiUsed).toBe(true);
    expect(fake.cancelled).toBe(0);
  });

  it('cancels the AI call when the browser drops the request (message changed)', async () => {
    fake.delayMs = 30_000;
    const before = await usage();
    const { req, body } = post(MESSAGE);
    body.catch(() => undefined);
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    req.destroy();
    await vi.waitFor(() => expect(fake.cancelled).toBe(1));
    expect((await usage()).requests).toBe(before.requests);
  });
});
