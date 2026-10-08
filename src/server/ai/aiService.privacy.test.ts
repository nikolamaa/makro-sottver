/**
 * AiService against the real personalize module (no mocks): the request a cloud provider receives must never
 * contain the customer's personal data, and every token must be restored in the reply the agent gets.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Analysis, Entity, Macro, Recommendation } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../shared/types.js';
import { analyzeMessage } from '../analysis/analyzer.js';
import { AiService } from './aiService.js';
import type { JsonRequest, LlmProvider } from './provider.js';

const MESSAGE =
  'Hi, I am Max Power (max.power@mail.com), username maxp77. What is the Maximum withdrawal? ' +
  'My BTC withdrawal of 0.05 BTC with tx 3f9a8b7c6d5e4f3a2b1c is still pending.';

function entity(type: Entity['type'], raw: string): Entity {
  const start = MESSAGE.indexOf(raw);
  return { type, value: raw, raw, start, end: start + raw.length };
}

const analysis: Analysis = {
  intents: [{ intent: 'withdrawal_pending', score: 0.9 }],
  sentiment: 'neutral',
  sentimentScore: 0,
  urgency: 'normal',
  urgencyReasons: [],
  entities: [
    entity('name', 'Max Power'),
    entity('email', 'max.power@mail.com'),
    entity('username', 'maxp77'),
    entity('amount', '0.05'),
    entity('tx_hash', '3f9a8b7c6d5e4f3a2b1c'),
  ],
  questions: [{ text: 'My BTC withdrawal with tx 3f9a8b7c6d5e4f3a2b1c is still pending', intent: 'withdrawal_pending' }],
  keywords: ['withdrawal'],
  rgRisk: false,
  rgSignals: [],
  isLikelyNonEnglish: false,
  wordCount: 30,
  source: 'local',
};

const macro = {
  id: 'm1',
  title: 'Pending crypto withdrawal',
  body: 'Hi {{user|there}},\n\nYour withdrawal is being processed and should arrive within {{eta_time}}.',
  intents: ['withdrawal_pending'],
  facts: [],
} as unknown as Macro;

const PERSONAL = ['Max Power', 'max.power@mail.com', 'maxp77', '3f9a8b7c6d5e4f3a2b1c', 'bc1qwallet9'];

function capturingProvider(reply: (req: JsonRequest<z.ZodType>) => string) {
  const requests: JsonRequest<z.ZodType>[] = [];
  const provider: LlmProvider = {
    id: 'anthropic',
    model: 'claude-haiku-5-5',
    isCloud: true,
    async generateJson<S extends z.ZodType>(req: JsonRequest<S>) {
      requests.push(req);
      const data = req.schema.parse({ reply: reply(req), used_fact_ids: [], unanswered_questions: [], placeholders: [], notes_for_agent: [] });
      return { data, usage: { provider: 'anthropic' as const, model: 'claude-haiku-5-5', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 } };
    },
    test: async () => ({ ok: true, detail: 'ok' }),
  };
  return { provider, requests };
}

function service(provider: LlmProvider): AiService {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.ai.provider = 'anthropic';
  return new AiService({ getSettings: () => settings, getApiKey: () => 'k', recordUsage: () => {}, monthSpendUsd: () => 0, providerFactory: () => provider });
}

describe('AiService privacy with the real pseudonymizer', () => {
  it('sends no personal data and restores every token it created', async () => {
    // The fake model echoes every token it was given, so restoration of each one is checked.
    const { provider, requests } = capturingProvider((req) => [...new Set(req.user.match(/⟦[A-Z_]+_\d+⟧/g) ?? [])].join(' | '));
    const variables = { user: 'Max', email: 'max.power@mail.com', username: 'maxp77', wallet_address: 'bc1qwallet9', amount: '0.05', crypto: 'BTC' };
    const res = await service(provider).personalize({ message: MESSAGE, analysis, macros: [macro], variables });

    const user = requests[0]!.user;
    for (const secret of PERSONAL) expect(user).not.toContain(secret);
    expect(user).toContain('What is the Maximum withdrawal?');
    expect(user).toContain('0.05 BTC');
    expect(user).toMatch(/<greeting>\nHi ⟦NAME_\d⟧,\n<\/greeting>/);

    expect(res.text).not.toMatch(/⟦/);
    for (const value of ['Max Power', 'max.power@mail.com', 'maxp77', '3f9a8b7c6d5e4f3a2b1c', 'bc1qwallet9', 'Max']) {
      expect(res.text.split(' | ')).toContain(value);
    }
    expect(res.warnings.some((w) => /could not restore/.test(w))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real analyzer + real pseudonymizer: phrasings the analyzer alone did not tokenize (review finding: these reached
// Claude verbatim through the automatic AI double-check).
// ---------------------------------------------------------------------------

/** The customer messages that leaked, with the personal values in them. */
const LEAKS: { message: string; secrets: string[] }[] = [
  { message: "Hi, I'm Jovana Petrovic. My withdrawal has been pending for 3 days, where is it?", secrets: ['Jovana Petrovic', 'Jovana', 'Petrovic'] },
  { message: 'I am Peter Parker, my deposit did not arrive.', secrets: ['Peter Parker', 'Peter', 'Parker'] },
  { message: 'Hi there, Ana Ivanovic here. My withdrawal is stuck.', secrets: ['Ana Ivanovic', 'Ana', 'Ivanovic'] },
  { message: "It's Ana here, my deposit is missing.", secrets: ['Ana'] },
  { message: "It's Nikola Markovic, can't log in to my account", secrets: ['Nikola Markovic', 'Nikola', 'Markovic'] },
  { message: 'I need to verify my account, my DOB is 14/03/1991.', secrets: ['14/03/1991'] },
  {
    message: 'Please send my withdrawal to IBAN DE89370400440532013000, card 4111 1111 1111 1111',
    secrets: ['DE89370400440532013000', '4111 1111 1111 1111'],
  },
  {
    message: 'For KYC: my address is 221B Baker Street, London NW1 6XE and passport no. X1234567',
    secrets: ['221B Baker Street, London NW1 6XE', 'Baker', 'London', 'NW1 6XE', 'X1234567'],
  },
];

/** True when `value` occurs in `text` as a whole word (so "Ana" is not found in "Analysis"). */
function containsWord(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(text);
}

/** Every distinct ⟦TOKEN⟧ in a prompt, joined with " | ": the fake model echoes them, so restoration is checked. */
function echoTokens(req: JsonRequest<z.ZodType>): string {
  return [...new Set(req.user.match(/⟦[A-Z_]+_\d+⟧/g) ?? [])].join(' | ') || 'no tokens';
}

/** A cloud provider that records every request and answers any purpose with the tokens it was given. */
function echoingProvider() {
  const requests: JsonRequest<z.ZodType>[] = [];
  const provider: LlmProvider = {
    id: 'anthropic',
    model: 'claude-haiku-5-5',
    isCloud: true,
    async generateJson<S extends z.ZodType>(req: JsonRequest<S>) {
      requests.push(req);
      const echo = echoTokens(req);
      const raw =
        req.purpose === 'rerank'
          ? { ranked: [{ id: 'm1', confidence: 80, reason: echo }], no_good_match: false, missing_topics: [] }
          : req.purpose === 'draft'
            ? { reply: echo, suggested_title: 'Pending withdrawal', suggested_intents: [], placeholders: [] }
            : { reply: echo, used_fact_ids: [], unanswered_questions: [], placeholders: [], notes_for_agent: [] };
      const data = req.schema.parse(raw) as z.infer<S>;
      return { data, usage: { provider: 'anthropic' as const, model: 'claude-haiku-5-5', inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 } };
    },
    test: async () => ({ ok: true, detail: 'ok' }),
  };
  return { provider, requests };
}

const candidate: Recommendation = {
  macroId: 'm1',
  title: 'Pending crypto withdrawal',
  categoryId: null,
  confidence: 50,
  reason: 'local',
  matchedTerms: [],
  coversIntents: ['withdrawal_pending'],
  verification: 'verified',
  warnings: [],
  breakdown: { semantic: 0.5, lexical: 0.5, intent: 1, usage: 0 },
};

describe('AiService privacy with the real analyzer (rerank, personalize, draft)', () => {
  it.each(LEAKS)('rerank sends no personal data and restores it: $message', async ({ message, secrets }) => {
    const { provider, requests } = echoingProvider();
    const res = await service(provider).rerank({ message, analysis: analyzeMessage(message), candidates: [candidate], macros: new Map([['m1', macro]]) });

    const user = requests[0]!.user;
    for (const secret of secrets) expect(containsWord(user, secret), `"${secret}" reached the provider`).toBe(false);
    expect(user).toMatch(/⟦[A-Z_]+_1⟧/);
    expect(res.aiUsed).toBe(true);
    const reason = res.recommendations[0]!.reason;
    expect(reason).not.toMatch(/⟦/);
    for (const secret of secrets) expect(reason).toContain(secret);
  });

  it('personalize and draft send none of it either and restore every value', async () => {
    const message = LEAKS.map((l) => l.message).join('\n');
    const secrets = LEAKS.flatMap((l) => l.secrets);
    const analysis = analyzeMessage(message);
    const { provider, requests } = echoingProvider();
    const ai = service(provider);
    const personalized = await ai.personalize({ message, analysis, macros: [macro], variables: {} });
    const drafted = await ai.draft({ message, analysis, variables: {}, facts: [] });

    expect(requests.map((r) => r.purpose)).toEqual(['personalize', 'draft']);
    for (const req of requests) {
      for (const secret of secrets) expect(containsWord(req.user, secret), `"${secret}" reached the provider (${req.purpose})`).toBe(false);
    }
    for (const text of [personalized.text, drafted.text]) {
      expect(text).not.toMatch(/⟦/);
      for (const secret of secrets) expect(text).toContain(secret);
    }
  });

  it('rerank masks the customer name the agent typed even where no detector finds it', async () => {
    const message = 'hello, jovana writing again. Jovana is my name on the account, where is my withdrawal?';
    const { provider, requests } = echoingProvider();
    const res = await service(provider).rerank({
      message,
      analysis: analyzeMessage(message),
      candidates: [candidate],
      macros: new Map([['m1', macro]]),
      variables: { user: 'Jovana', eta_time: '24 hours' },
    });
    expect(containsWord(requests[0]!.user, 'Jovana')).toBe(false);
    expect(requests[0]!.user).toContain('⟦NAME_1⟧ is my name');
    expect(res.recommendations[0]!.reason).toContain('Jovana');
  });

  it('keeps amounts, tx hashes, bet ids and ordinary capitalized words readable for the model', async () => {
    const message =
      'I am Waiting for my BTC withdrawal of 0.05 BTC, bet id 1234567890123456 and tx ' +
      '3f9a8b7c6d5e4f3a2b1c3f9a8b7c6d5e4f3a2b1c3f9a8b7c6d5e4f3a2b1c3f9a. It has been 3 days. Stake VIP here.';
    const { provider, requests } = echoingProvider();
    await service(provider).rerank({ message, analysis: analyzeMessage(message), candidates: [candidate], macros: new Map([['m1', macro]]) });
    const user = requests[0]!.user;
    for (const kept of ['I am Waiting for my BTC withdrawal of 0.05 BTC', 'It has been 3 days.', 'Stake VIP here.']) expect(user).toContain(kept);
    expect(user).toContain('bet id ⟦BET_ID_1⟧');
    expect(user).toContain('tx ⟦TX_HASH_1⟧');
    expect(user).not.toMatch(/⟦(?:NAME|CARD|PHONE|DOC_ID|DOB|ADDRESS|IBAN)_/);
  });
});
