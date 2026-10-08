/**
 * AssistService.rerank() with fakes for the search index, library and AI: what reaches AiService.rerank
 * (agent-entered variables for pseudonymization, the cancel signal) and when the AI is skipped.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, Macro, Recommendation } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../shared/types.js';
import type { AiService } from '../ai/aiService.js';
import type { MacroIndex } from '../search/macroIndex.js';
import { AssistService } from './assist.js';
import type { LibraryService } from './library.js';

const MESSAGE = 'hello, jovana writing again. Jovana is the name on my account, my BTC withdrawal has been pending for 2 days';

function rec(id: string, confidence: number): Recommendation {
  return {
    macroId: id,
    title: `Macro ${id}`,
    categoryId: null,
    confidence,
    reason: 'local',
    matchedTerms: [],
    coversIntents: ['withdrawal_pending'],
    verification: 'verified',
    warnings: [],
    breakdown: { semantic: 0.5, lexical: 0.5, intent: 1, usage: 0 },
  };
}

function setup(opts: { ready?: boolean; rerank?: boolean } = {}) {
  const candidates = [rec('a', 70), rec('b', 60)];
  const index = {
    search: vi.fn(async () => ({ recommendations: candidates, noGoodMatch: false, uncoveredIntents: [] })),
  } as unknown as MacroIndex;
  const library = { get: vi.fn((id: string) => ({ id, title: `Macro ${id}`, body: 'Hi {{user}}', intents: [], facts: [] }) as unknown as Macro) };
  type RerankInput = { message: string; candidates: Recommendation[]; variables?: Record<string, string>; signal?: AbortSignal };
  const aiRerank = vi.fn(async (input: RerankInput) => ({
    recommendations: [...input.candidates].reverse().map((c) => ({ ...c, confidence: 90 })),
    aiUsed: true,
    usage: null,
  }));
  const ai = { isReady: () => opts.ready ?? true, rerank: aiRerank } as unknown as AiService;
  const settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  settings.ai.rerank = opts.rerank ?? true;
  const service = new AssistService(library as unknown as LibraryService, index, ai, () => settings);
  return { service, aiRerank };
}

describe('AssistService.rerank', () => {
  it('hands the cleaned agent-entered variables (over the detected ones) to the AI for pseudonymization', async () => {
    const { service, aiRerank } = setup();
    const res = await service.rerank(MESSAGE, { ' User ': ' Jovana ', eta_time: '24 hours', 'bad key!': 'x', empty: '  ' });
    expect(res.aiUsed).toBe(true);
    expect(res.recommendations.map((r) => r.macroId)).toEqual(['b', 'a']);
    const input = aiRerank.mock.calls[0]![0];
    expect(input.message).toBe(MESSAGE);
    expect(input.variables).toMatchObject({ user: 'Jovana', eta_time: '24 hours' });
    expect(Object.keys(input.variables ?? {})).not.toContain('bad key!');
    expect(Object.keys(input.variables ?? {})).not.toContain('empty');
  });

  it('works without variables and passes the cancel signal as the third argument', async () => {
    const { service, aiRerank } = setup();
    const ctrl = new AbortController();
    await service.rerank(MESSAGE, undefined, ctrl.signal);
    expect(aiRerank.mock.calls[0]![0]).toMatchObject({ signal: ctrl.signal });

    ctrl.abort();
    const skipped = await service.rerank(MESSAGE, { user: 'Jovana' }, ctrl.signal);
    expect(skipped.aiUsed).toBe(false);
    expect(aiRerank).toHaveBeenCalledTimes(1);
  });

  it('does not call the AI when it is not ready or the double-check is off', async () => {
    for (const opts of [{ ready: false }, { rerank: false }]) {
      const { service, aiRerank } = setup(opts);
      const res = await service.rerank(MESSAGE, { user: 'Jovana' });
      expect(res).toMatchObject({ aiUsed: false, llm: null });
      expect(aiRerank).not.toHaveBeenCalled();
    }
  });
});
