import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { Analysis, AppSettings, Fact, LlmUsage, Macro, Recommendation } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../shared/types.js';
import { checkGrounding, pseudonymize } from '../personalize/personalize.js';
import { AiService } from './aiService.js';
import { AiError, type JsonRequest, type LlmProvider, type LlmPurpose } from './provider.js';

vi.mock('../personalize/personalize.js', () => ({
  // Simple fake: replaces email/name entities (and known user/email/username values found in the text) with
  // numbered tokens. Like the real one, it ignores custom variable names; the service must tokenize those itself.
  pseudonymize: vi.fn((text: string, entities: { type: string; raw: string }[], known: Record<string, string> = {}) => {
    const mapping: Record<string, string> = {};
    let out = text;
    let n = 0;
    for (const e of entities) {
      if (e.type !== 'email' && e.type !== 'name') continue;
      const token = `⟦${e.type.toUpperCase()}_${++n}⟧`;
      mapping[token] = e.raw;
      out = out.split(e.raw).join(token);
    }
    for (const [key, value] of Object.entries(known)) {
      if (!['user', 'email', 'username'].includes(key)) continue;
      if (Object.values(mapping).includes(value) || !out.includes(value)) continue;
      const token = `⟦KNOWN_${++n}⟧`;
      mapping[token] = value;
      out = out.split(value).join(token);
    }
    return { text: out, mapping };
  }),
  restorePseudonyms: vi.fn((text: string, mapping: Record<string, string>) =>
    Object.entries(mapping).reduce((acc, [token, value]) => acc.split(token).join(value), text),
  ),
  checkGrounding: vi.fn(() => [{ kind: 'unsupported_number', text: '48 hours', detail: 'Not found in the macro or facts' }]),
  variablesFromAnalysis: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USAGE: LlmUsage = { provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 1500, outputTokens: 400, costUsd: 0.00035, latencyMs: 900 };

interface FakeProvider extends LlmProvider {
  requests: JsonRequest<z.ZodType>[];
}

/** Provider double: records requests and validates the canned answer against the request's schema. */
function fakeProvider(opts: { isCloud?: boolean; answer?: (req: JsonRequest<z.ZodType>) => unknown; error?: AiError }): FakeProvider {
  const requests: JsonRequest<z.ZodType>[] = [];
  const isCloud = opts.isCloud ?? true;
  return {
    id: isCloud ? 'anthropic' : 'ollama',
    model: isCloud ? 'claude-haiku-5-5' : 'qwen3:4b',
    isCloud,
    requests,
    async generateJson<S extends z.ZodType>(req: JsonRequest<S>) {
      requests.push(req);
      if (opts.error) throw opts.error;
      const data = req.schema.parse(opts.answer?.(req)) as z.infer<S>;
      return { data, usage: { ...USAGE, provider: isCloud ? 'anthropic' : 'ollama' } };
    },
    test: async () => ({ ok: true, detail: 'fake ok' }),
  };
}

function settingsWith(patch: { ai?: Partial<AppSettings['ai']>; privacy?: Partial<AppSettings['privacy']> } = {}): AppSettings {
  const s = structuredClone(DEFAULT_SETTINGS);
  Object.assign(s.ai, { provider: 'anthropic', anthropicKeySet: true }, patch.ai);
  Object.assign(s.privacy, patch.privacy);
  return s;
}

function serviceWith(provider: LlmProvider | null, settings = settingsWith(), spend = 0) {
  const recorded: { purpose: LlmPurpose; usage: LlmUsage }[] = [];
  const service = new AiService({
    getSettings: () => settings,
    getApiKey: () => 'sk-ant-test',
    recordUsage: (purpose, usage) => recorded.push({ purpose, usage }),
    monthSpendUsd: () => spend,
    providerFactory: () => provider,
  });
  return { service, recorded };
}

const MESSAGE = "Hi, I'm John Smith (john@example.com). My withdrawal of 250 USDT is pending for 2 days. Where is it?";

const analysis: Analysis = {
  intents: [{ intent: 'withdrawal_pending', score: 0.9 }],
  sentiment: 'frustrated',
  sentimentScore: -0.4,
  urgency: 'high',
  urgencyReasons: [],
  entities: [
    { type: 'name', value: 'John Smith', raw: 'John Smith', start: 8, end: 18 },
    { type: 'email', value: 'john@example.com', raw: 'john@example.com', start: 20, end: 36 },
    { type: 'amount', value: '250', raw: '250', start: 59, end: 62 },
  ],
  questions: [{ text: 'Where is it? (john@example.com)', intent: 'withdrawal_pending' }],
  keywords: ['withdrawal', 'john'],
  rgRisk: false,
  rgSignals: [],
  isLikelyNonEnglish: false,
  wordCount: 20,
  source: 'local',
};

function fact(id: string, status: Fact['status'], statement = `Statement ${id}`, value = `value ${id}`): Fact {
  return { id, macroId: 'm1', key: `k.${id}`, statement, value, sourceUrl: null, evidenceQuote: null, status, lastCheckedAt: null };
}

function macro(id: string, overrides: Partial<Macro> = {}): Macro {
  return {
    id,
    title: `Macro ${id}`,
    body: 'Hi {{user|there}},\n\nYour withdrawal of {{amount}} {{currency}} is being processed. ETA: {{eta_time}}.',
    categoryId: null,
    tags: [],
    intents: ['withdrawal_pending'],
    triggers: [],
    notes: '',
    shortcut: '',
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    archivedAt: null,
    isFavorite: false,
    useCount: 0,
    lastUsedAt: null,
    verification: 'verified',
    facts: [],
    ...overrides,
  };
}

const VARIABLES = { user: 'John', email: 'john@example.com', amount: '250', currency: 'USDT' };

const personalizeAnswer = {
  reply: 'Hi ⟦USER_1⟧,\n\nSorry for the wait. Your withdrawal of 250 USDT is being processed. ETA: [ENTER ETA TIME].\nWe will email ⟦EMAIL_2⟧.',
  used_fact_ids: ['f-verified', 'f-ghost'],
  unanswered_questions: ['Why is ⟦EMAIL_2⟧ not confirmed?'],
  placeholders: ['[ENTER ETA TIME]', '[ENTER NOT IN TEXT]'],
  notes_for_agent: ['Check the withdrawal for ⟦USER_1⟧ in the back office.', ' '],
};

const personalizeInput = (macros: Macro[] = [macro('m1')]) => ({ message: MESSAGE, analysis, macros, variables: { ...VARIABLES } });

beforeEach(() => {
  vi.mocked(pseudonymize).mockClear();
  vi.mocked(checkGrounding).mockClear();
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

describe('availability', () => {
  it('reports not_configured when there is no provider', async () => {
    const { service } = serviceWith(null, settingsWith({ ai: { provider: 'none' } }));
    expect(service.provider()).toBeNull();
    expect(service.isReady()).toBe(false);
    expect(service.status()).toMatchObject({ provider: 'none', ready: false, detail: expect.stringMatching(/AI is off/) });
    await expect(service.personalize(personalizeInput())).rejects.toMatchObject({ code: 'not_configured' });
    await expect(service.draft({ message: MESSAGE, analysis, variables: {}, facts: [] })).rejects.toMatchObject({ code: 'not_configured' });
    await expect(service.test()).resolves.toMatchObject({ ok: false });
  });

  it('blocks paid providers once the monthly budget is spent', async () => {
    const provider = fakeProvider({ answer: () => personalizeAnswer });
    const { service } = serviceWith(provider, settingsWith({ ai: { monthlyBudgetUsd: 5 } }), 5);
    expect(service.isReady()).toBe(false);
    expect(service.status().detail).toMatch(/budget of \$5\.00 reached/);
    expect(service.provider()).toBe(provider);
    await expect(service.personalize(personalizeInput())).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(provider.requests).toHaveLength(0);
  });

  it('does not cap local providers or a budget of 0', async () => {
    const local = serviceWith(fakeProvider({ isCloud: false, answer: () => personalizeAnswer }), settingsWith({ ai: { provider: 'ollama', monthlyBudgetUsd: 5 } }), 99);
    await expect(local.service.personalize(personalizeInput())).resolves.toMatchObject({ mode: 'ai' });
    const uncapped = serviceWith(fakeProvider({ answer: () => personalizeAnswer }), settingsWith({ ai: { monthlyBudgetUsd: 0 } }), 99);
    expect(uncapped.service.isReady()).toBe(true);
  });

  it('strict local mode blocks cloud providers but allows local ones', async () => {
    const cloud = fakeProvider({ answer: () => personalizeAnswer });
    const { service } = serviceWith(cloud, settingsWith({ privacy: { strictLocal: true } }));
    expect(service.provider()).toBeNull();
    expect(service.status()).toMatchObject({ ready: false, detail: expect.stringMatching(/Strict local/) });
    await expect(service.personalize(personalizeInput())).rejects.toMatchObject({ code: 'strict_local' });
    await expect(service.test()).resolves.toMatchObject({ ok: false, detail: expect.stringMatching(/Strict local/) });
    expect(cloud.requests).toHaveLength(0);

    const noKey = serviceWith(null, settingsWith({ privacy: { strictLocal: true } }));
    await expect(noKey.service.personalize(personalizeInput())).rejects.toMatchObject({ code: 'strict_local' });

    const local = serviceWith(fakeProvider({ isCloud: false }), settingsWith({ ai: { provider: 'ollama' }, privacy: { strictLocal: true } }));
    expect(local.service.isReady()).toBe(true);
  });

  it('treats Ollama on another computer as cloud for strict local and pseudonymization, but never as paid', async () => {
    const remote: FakeProvider = { ...fakeProvider({ isCloud: true, answer: () => personalizeAnswer }), id: 'ollama', model: 'qwen3:4b' };
    const ollama = settingsWith({ ai: { provider: 'ollama', monthlyBudgetUsd: 5 } });

    const strict = serviceWith(remote, { ...ollama, privacy: { ...ollama.privacy, strictLocal: true } });
    expect(strict.service.status()).toMatchObject({ ready: false, detail: expect.stringMatching(/Ollama URL points to another computer/) });
    await expect(strict.service.personalize(personalizeInput())).rejects.toMatchObject({ code: 'strict_local' });

    // Budget already spent on Claude does not block a free provider.
    const { service } = serviceWith(remote, ollama, 99);
    expect(service.status()).toEqual({ provider: 'ollama', ready: true, detail: 'Ollama (qwen3:4b) on another computer, personal data pseudonymized' });
    await service.personalize(personalizeInput());
    const req = remote.requests[0]!;
    expect(req.user).not.toContain('john@example.com');
    expect(req.timeoutMs).toBeGreaterThan(30_000);
  });

  it('status and test describe a ready provider', async () => {
    const { service } = serviceWith(fakeProvider({}));
    expect(service.status()).toEqual({ provider: 'anthropic', ready: true, detail: 'Claude (claude-haiku-5-5), personal data pseudonymized' });
    await expect(service.test()).resolves.toEqual({ ok: true, detail: 'fake ok' });
  });

  it('builds and caches the real providers from settings when no factory is given', () => {
    let settings = settingsWith();
    let key: string | null = 'sk-ant-test';
    const service = new AiService({ getSettings: () => settings, getApiKey: () => key, recordUsage: () => {}, monthSpendUsd: () => 0 });
    const first = service.provider();
    expect(first).toMatchObject({ id: 'anthropic', model: 'claude-haiku-5-5', isCloud: true });
    expect(service.provider()).toBe(first);

    settings = settingsWith({ ai: { provider: 'ollama' } });
    expect(service.provider()).toMatchObject({ id: 'ollama', model: DEFAULT_SETTINGS.ai.ollamaModel, isCloud: false });

    settings = settingsWith();
    key = null;
    expect(service.provider()).toBeNull();
    expect(service.status().detail).toMatch(/Anthropic API key/);
  });
});

// ---------------------------------------------------------------------------
// personalize()
// ---------------------------------------------------------------------------

describe('personalize', () => {
  it('sends only pseudonyms to a cloud provider and restores them in the result', async () => {
    const provider = fakeProvider({ answer: () => personalizeAnswer });
    const { service } = serviceWith(provider);
    const res = await service.personalize(personalizeInput());

    const req = provider.requests[0]!;
    for (const secret of ['john@example.com', 'John Smith', 'John']) expect(req.user).not.toContain(secret);
    expect(req.user).toContain('⟦NAME_1⟧');
    expect(req.user).toContain('⟦EMAIL_2⟧');
    expect(req.user).toContain('user: ⟦USER_1⟧');
    expect(req.user).toContain('email: ⟦EMAIL_2⟧');
    expect(req.user).toContain('<greeting>\nHi ⟦USER_1⟧,\n</greeting>');
    expect(req.user).toContain('Where is it? (⟦EMAIL_2⟧)');
    expect(req.user).toContain('250 USDT');
    expect(req.user).toContain('amount: 250');
    // Non-personal variable values and the detected questions also go through the PII scrubber.
    expect(vi.mocked(pseudonymize)).toHaveBeenCalledWith(MESSAGE, analysis.entities, { user: 'John', email: 'john@example.com' }, [
      '250',
      'USDT',
      'Where is it? (john@example.com)',
    ]);

    expect(res.text).toBe('Hi John,\n\nSorry for the wait. Your withdrawal of 250 USDT is being processed. ETA: [ENTER ETA TIME].\nWe will email john@example.com.');
    expect(res.unansweredQuestions).toEqual(['Why is john@example.com not confirmed?']);
    expect(res.warnings).toContain('Check the withdrawal for John in the back office.');
    expect(res.mode).toBe('ai');
    expect(res.filledVariables).toEqual(VARIABLES);
    expect(res.llm).toEqual(USAGE);
  });

  it('sends raw text when pseudonymization is off or the provider is local', async () => {
    const off = fakeProvider({ answer: () => personalizeAnswer });
    await serviceWith(off, settingsWith({ ai: { pseudonymize: false } })).service.personalize(personalizeInput());
    expect(off.requests[0]!.user).toContain('john@example.com');
    expect(off.requests[0]!.user).toContain('<greeting>\nHi John,\n</greeting>');

    const local = fakeProvider({ isCloud: false, answer: () => personalizeAnswer });
    await serviceWith(local, settingsWith({ ai: { provider: 'ollama' } })).service.personalize(personalizeInput());
    expect(local.requests[0]!.user).toContain('John Smith');
    expect(vi.mocked(pseudonymize)).not.toHaveBeenCalled();
  });

  it('uses the configured effort, a thinking-safe token limit and the static system prompt', async () => {
    const provider = fakeProvider({ answer: () => personalizeAnswer });
    await serviceWith(provider, settingsWith({ ai: { effort: 'medium' } })).service.personalize(personalizeInput());
    const req = provider.requests[0]!;
    expect(req).toMatchObject({ purpose: 'personalize', effort: 'medium' });
    expect(req.maxTokens).toBeGreaterThanOrEqual(2048);
    expect(req.timeoutMs).toBeGreaterThan(0);
    expect(req.system).not.toContain('John');
  });

  it('sends only verified/unchecked facts and filters reported fact ids', async () => {
    const facts = [fact('f-verified', 'verified'), fact('f-unchecked', 'unchecked'), fact('f-outdated', 'outdated', 'Old limit'), fact('f-contra', 'contradicted', 'Wrong fee')];
    const provider = fakeProvider({ answer: () => personalizeAnswer });
    const res = await serviceWith(provider).service.personalize(personalizeInput([macro('m1', { facts, title: 'Pending withdrawal' })]));

    const user = provider.requests[0]!.user;
    expect(user).toContain('id="f-verified" status="verified"');
    expect(user).toContain('id="f-unchecked" status="unchecked"');
    expect(user).not.toContain('f-outdated');
    expect(user).not.toContain('f-contra');
    expect(res.usedFactIds).toEqual(['f-verified']);
    expect(res.warnings.some((w) => w.startsWith('Pending withdrawal:') && w.includes('Old limit'))).toBe(true);
    expect(res.warnings.some((w) => w.includes('Wrong fee'))).toBe(true);
  });

  it('wires the grounding guardrail with original (not pseudonymized) sources', async () => {
    const facts = [fact('f-verified', 'verified'), fact('f-outdated', 'outdated')];
    const m = macro('m1', { facts });
    const res = await serviceWith(fakeProvider({ answer: () => personalizeAnswer })).service.personalize(personalizeInput([m]));

    expect(vi.mocked(checkGrounding)).toHaveBeenCalledTimes(1);
    const [text, sources] = vi.mocked(checkGrounding).mock.calls[0]!;
    expect(text).toBe(res.text);
    expect(sources.macroBodies).toEqual([m.body]);
    expect(sources.facts.map((f) => (f as Fact).id)).toEqual(['f-verified']);
    expect(sources.message).toBe(MESSAGE);
    expect(sources.variables).toEqual(VARIABLES);
    expect(res.guardrail).toEqual([{ kind: 'unsupported_number', text: '48 hours', detail: 'Not found in the macro or facts' }]);
  });

  it('collects placeholders from the text and maps them to macro variables', async () => {
    const res = await serviceWith(fakeProvider({ answer: () => personalizeAnswer })).service.personalize(personalizeInput());
    expect(res.placeholders).toEqual([{ label: '[ENTER ETA TIME]', variable: 'eta_time' }]);

    const custom = { ...personalizeAnswer, reply: 'Hi John,\n[ENTER ANSWER ABOUT KYC] and [ENTER BONUS CODE]', placeholders: [] };
    const m = macro('m1', { body: 'Use code {{bonus_code}}.' });
    const res2 = await serviceWith(fakeProvider({ answer: () => custom })).service.personalize(personalizeInput([m]));
    expect(res2.placeholders).toEqual([
      { label: '[ENTER ANSWER ABOUT KYC]', variable: null },
      { label: '[ENTER BONUS CODE]', variable: 'bonus_code' },
    ]);
  });

  it('adds RG and unknown-token warnings', async () => {
    const answer = { ...personalizeAnswer, reply: 'Hi ⟦NAME_9⟧,\nWe are here for you.' };
    const res = await serviceWith(fakeProvider({ answer: () => answer })).service.personalize({
      ...personalizeInput(),
      analysis: { ...analysis, rgRisk: true, rgSignals: ['lost my rent'] },
    });
    expect(res.warnings.some((w) => /Responsible gambling/.test(w))).toBe(true);
    expect(res.warnings.some((w) => /could not restore/.test(w))).toBe(true);
  });

  it('masks custom personal variables as whole words only, without garbling other words', async () => {
    const provider = fakeProvider({ answer: () => personalizeAnswer });
    const message = 'Max here. What is the Maximum withdrawal? My wallet is bc1qxy9 and txid 0xabc123.';
    const variables = { player_name: 'Max', wallet: 'bc1qxy9', txid: '0xabc123', amount: '250', note: 'Max asked twice', constructor: 'x' };
    await serviceWith(provider).service.personalize({ message, analysis: { ...analysis, entities: [], questions: [] }, macros: [macro('m1')], variables });

    const user = provider.requests[0]!.user;
    expect(user).toContain('⟦PLAYER_NAME_1⟧ here. What is the Maximum withdrawal? My wallet is ⟦WALLET_1⟧ and txid ⟦TXID_1⟧.');
    expect(user).toContain('note: ⟦PLAYER_NAME_1⟧ asked twice');
    expect(user).toContain('amount: 250');
    expect(user).toContain('constructor: x');
    for (const secret of ['bc1qxy9', '0xabc123', 'Max ']) expect(user).not.toContain(secret);
  });

  it('fills {{variables}} the model left in the reply', async () => {
    const answer = { ...personalizeAnswer, reply: 'Hi {{user}},\n\nYour {{amount}} {{currency|funds}} arrive in {{eta_time}}. {{bonus_code|No code needed}}.' };
    const res = await serviceWith(fakeProvider({ answer: () => answer })).service.personalize({
      ...personalizeInput(),
      variables: { amount: '250', currency: 'USDT' },
    });
    expect(res.text).toBe('Hi there,\n\nYour 250 USDT arrive in [ENTER ETA TIME]. No code needed.');
    expect(res.placeholders).toEqual([{ label: '[ENTER ETA TIME]', variable: 'eta_time' }]);
  });

  it('records usage on success and on billed failures, and rethrows errors', async () => {
    const ok = serviceWith(fakeProvider({ answer: () => personalizeAnswer }));
    await ok.service.personalize(personalizeInput());
    expect(ok.recorded).toEqual([{ purpose: 'personalize', usage: USAGE }]);

    const refused = serviceWith(fakeProvider({ error: new AiError('refusal', 'declined', USAGE) }));
    await expect(refused.service.personalize(personalizeInput())).rejects.toMatchObject({ code: 'refusal' });
    expect(refused.recorded).toEqual([{ purpose: 'personalize', usage: USAGE }]);

    const offline = serviceWith(fakeProvider({ error: new AiError('network', 'down') }));
    await expect(offline.service.personalize(personalizeInput())).rejects.toMatchObject({ code: 'network' });
    expect(offline.recorded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// draft()
// ---------------------------------------------------------------------------

describe('draft', () => {
  const draftAnswer = {
    reply: 'Hi ⟦USER_1⟧,\n\nThanks for reaching out. [ENTER ANSWER ABOUT USERNAME CHANGE]',
    suggested_title: 'Username change request ⟦USER_1⟧',
    suggested_intents: ['general', 'general', 'account_access'],
    placeholders: ['[ENTER ANSWER ABOUT USERNAME CHANGE]'],
  };

  it('uses only verified facts, pseudonymizes and cleans the result', async () => {
    const provider = fakeProvider({ answer: () => draftAnswer });
    const { service, recorded } = serviceWith(provider);
    const res = await service.draft({
      message: MESSAGE,
      analysis,
      variables: { user: 'John' },
      facts: [fact('f1', 'verified'), fact('f2', 'unchecked'), fact('f1', 'verified')],
    });

    const req = provider.requests[0]!;
    expect(req.purpose).toBe('draft');
    expect(req.user).toContain('<fact id="f1">');
    expect(req.user).not.toContain('f2');
    expect(req.user).not.toContain('john@example.com');
    expect(res.text).toBe('Hi John,\n\nThanks for reaching out. [ENTER ANSWER ABOUT USERNAME CHANGE]');
    expect(res.suggestedTitle).toBe('Username change request');
    expect(res.suggestedIntents).toEqual(['general', 'account_access']);
    expect(res.placeholders).toEqual([{ label: '[ENTER ANSWER ABOUT USERNAME CHANGE]', variable: null }]);
    expect(res.guardrail).toHaveLength(1);
    expect(vi.mocked(checkGrounding).mock.calls[0]![1]).toMatchObject({ macroBodies: [], message: MESSAGE, variables: { user: 'John' } });
    expect(res.llm).toEqual(USAGE);
    expect(recorded).toEqual([{ purpose: 'draft', usage: USAGE }]);
  });

  it('warns when no verified facts were available', async () => {
    const res = await serviceWith(fakeProvider({ answer: () => draftAnswer })).service.draft({ message: 'hi', analysis, variables: {}, facts: [] });
    expect(res.warnings.some((w) => /No verified facts/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rerank()
// ---------------------------------------------------------------------------

function rec(id: string, confidence: number): Recommendation {
  return {
    macroId: id,
    title: `Macro ${id}`,
    categoryId: null,
    confidence,
    reason: `local reason ${id}`,
    matchedTerms: ['withdrawal'],
    coversIntents: ['withdrawal_pending'],
    verification: 'verified',
    warnings: [`warning ${id}`],
    breakdown: { semantic: 0.5, lexical: 0.4, intent: 1, usage: 0.1 },
  };
}

describe('rerank', () => {
  const candidates = [rec('a', 80), rec('b', 60), rec('c', 50)];
  const macros = new Map([
    ['a', macro('a', { body: 'Hi {{user|there}},\n\nYour {{amount}} withdrawal   is pending.' })],
    ['b', macro('b')],
    ['c', macro('c')],
  ]);
  const input = { message: MESSAGE, analysis, candidates, macros };

  it('maps the AI ranking back onto the recommendations', async () => {
    const provider = fakeProvider({
      answer: () => ({
        ranked: [
          { id: 'a', confidence: 41.6, reason: 'Generic answer for ⟦NAME_1⟧.' },
          { id: 'ghost', confidence: 99, reason: 'Hallucinated.' },
          { id: 'b', confidence: 92, reason: 'Explains pending USDT withdrawals.' },
          { id: 'b', confidence: 10, reason: 'Duplicate.' },
        ],
        no_good_match: false,
        missing_topics: [],
      }),
    });
    const { service, recorded } = serviceWith(provider);
    const res = await service.rerank(input);
    const out = res.recommendations;

    expect(res).toMatchObject({ aiUsed: true, usage: USAGE });
    expect(out.map((r) => [r.macroId, r.confidence])).toEqual([
      ['b', 92],
      ['a', 42],
      ['c', 42],
    ]);
    expect(out[0]).toEqual({ ...candidates[1], confidence: 92, reason: 'Explains pending USDT withdrawals.' });
    expect(out[1]!.reason).toBe('Generic answer for John Smith.');
    expect(out[2]).toEqual({ ...candidates[2], confidence: 42 });
    expect(recorded).toEqual([{ purpose: 'rerank', usage: USAGE }]);

    const user = provider.requests[0]!.user;
    expect(user).toContain('<candidate id="a">');
    expect(user).toContain('summary: Hi there, Your withdrawal is pending.');
    expect(user).not.toContain('{{');
    expect(user).not.toContain('john@example.com');
  });

  const unchanged = { recommendations: candidates, aiUsed: false, usage: null };
  const rankAll = () => ({
    ranked: [
      { id: 'c', confidence: 88, reason: 'Best fit.' },
      { id: 'a', confidence: 70, reason: 'Close.' },
      { id: 'b', confidence: 20, reason: 'Off topic.' },
    ],
    no_good_match: false,
    missing_topics: [],
  });

  it('returns the original candidates on any AiError', async () => {
    const failing = serviceWith(fakeProvider({ error: new AiError('network', 'down') }));
    const res = await failing.service.rerank(input);
    expect(res).toEqual(unchanged);
    expect(res.recommendations).toBe(candidates);

    const off = serviceWith(null, settingsWith({ ai: { provider: 'none' } }));
    await expect(off.service.rerank(input)).resolves.toEqual(unchanged);

    const broke = serviceWith(fakeProvider({ answer: () => ({}) }), settingsWith(), 0);
    await expect(broke.service.rerank(input)).rejects.toThrow();
  });

  it('records the usage of billed calls that still failed', async () => {
    const { service, recorded } = serviceWith(fakeProvider({ error: new AiError('invalid_output', 'cut off', USAGE) }));
    await expect(service.rerank(input)).resolves.toEqual(unchanged);
    expect(recorded).toEqual([{ purpose: 'rerank', usage: USAGE }]);
  });

  it('hands the cancel signal to the provider and keeps the local ranking once the request is dropped', async () => {
    const ctrl = new AbortController();
    const live = fakeProvider({ answer: rankAll });
    await expect(serviceWith(live).service.rerank({ ...input, signal: ctrl.signal })).resolves.toMatchObject({ aiUsed: true });
    expect(live.requests[0]!.signal).toBe(ctrl.signal);

    // Already dropped: the provider is not called at all.
    ctrl.abort();
    const skipped = fakeProvider({ answer: rankAll });
    await expect(serviceWith(skipped).service.rerank({ ...input, signal: ctrl.signal })).resolves.toEqual(unchanged);
    expect(skipped.requests).toHaveLength(0);

    // Dropped while the provider was working: local ranking, nothing billed is recorded.
    const cancelled = serviceWith(fakeProvider({ error: new AiError('cancelled', 'The AI request was cancelled.') }));
    await expect(cancelled.service.rerank({ ...input, signal: new AbortController().signal })).resolves.toEqual(unchanged);
    expect(cancelled.recorded).toEqual([]);
  });

  it('keeps the local ranking when the answer names none of the candidates', async () => {
    const provider = fakeProvider({ answer: () => ({ ranked: [{ id: 'ghost', confidence: 99, reason: 'x' }], no_good_match: false, missing_topics: [] }) });
    const { service, recorded } = serviceWith(provider);
    await expect(service.rerank(input)).resolves.toEqual(unchanged);
    expect(recorded).toHaveLength(1);
  });

  it('applies the monthly budget and strict local mode without calling the provider', async () => {
    const cloud = fakeProvider({ answer: rankAll });
    await expect(serviceWith(cloud, settingsWith({ ai: { monthlyBudgetUsd: 1 } }), 1).service.rerank(input)).resolves.toEqual(unchanged);
    await expect(serviceWith(cloud, settingsWith({ privacy: { strictLocal: true } })).service.rerank(input)).resolves.toEqual(unchanged);
    expect(cloud.requests).toHaveLength(0);

    // A local model is allowed in strict mode, is never capped, and gets the message as is.
    const local = fakeProvider({ isCloud: false, answer: rankAll });
    const settings = settingsWith({ ai: { provider: 'ollama', monthlyBudgetUsd: 1 }, privacy: { strictLocal: true } });
    const res = await serviceWith(local, settings, 99).service.rerank(input);
    expect(res.aiUsed).toBe(true);
    expect(res.recommendations.map((r) => r.macroId)).toEqual(['c', 'a', 'b']);
    expect(local.requests[0]!.user).toContain('john@example.com');
  });

  it('pseudonymizes for cloud providers only when the setting is on', async () => {
    const masked = fakeProvider({ answer: rankAll });
    await serviceWith(masked).service.rerank(input);
    expect(masked.requests[0]!.user).not.toContain('john@example.com');
    expect(masked.requests[0]!.user).not.toContain('John Smith');

    const plain = fakeProvider({ answer: rankAll });
    await serviceWith(plain, settingsWith({ ai: { pseudonymize: false } })).service.rerank(input);
    expect(plain.requests[0]!.user).toContain('john@example.com');
  });

  it('pseudonymizes the agent-entered personal variables the analyzer did not detect', async () => {
    const provider = fakeProvider({ answer: rankAll });
    const message = 'Hi, John here. Where is my withdrawal?';
    await serviceWith(provider).service.rerank({ ...input, message, analysis: { ...analysis, entities: [] }, variables: { user: 'John', eta_time: '24 hours' } });
    expect(vi.mocked(pseudonymize)).toHaveBeenLastCalledWith(message, [], { user: 'John' }, expect.arrayContaining(['24 hours']));
    expect(provider.requests[0]!.user).not.toContain('John');
    expect(provider.requests[0]!.user).toContain('Hi, ⟦KNOWN_1⟧ here.');
  });

  it('skips the call when there is nothing to rank', async () => {
    const provider = fakeProvider({});
    await expect(serviceWith(provider).service.rerank({ ...input, candidates: [] })).resolves.toEqual({ recommendations: [], aiUsed: false, usage: null });
    expect(provider.requests).toHaveLength(0);
  });
});
