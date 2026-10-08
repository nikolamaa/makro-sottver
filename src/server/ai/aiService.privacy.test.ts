/**
 * AiService against the real personalize module (no mocks): the request a cloud provider receives must never
 * contain the customer's personal data, and every token must be restored in the reply the agent gets.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { Analysis, Entity, Macro } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../shared/types.js';
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
