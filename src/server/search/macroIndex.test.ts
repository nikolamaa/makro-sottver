import { describe, expect, it } from 'vitest';
import type { Analysis, Fact, Intent, Macro } from '../../shared/types.js';
import { createBuiltinEmbedder, type EmbedKind, type Embedder } from './embedder.js';
import { MacroIndex, type EmbeddingCache } from './macroIndex.js';

function macro(id: string, title: string, intents: Intent[], body: string, extra: Partial<Macro> = {}): Macro {
  return {
    id,
    title,
    body,
    categoryId: null,
    tags: [],
    intents,
    triggers: [],
    notes: '',
    shortcut: '',
    version: 1,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    archivedAt: null,
    isFavorite: false,
    useCount: 0,
    lastUsedAt: null,
    verification: 'unverified',
    facts: [],
    ...extra,
  };
}

const LIBRARY: Macro[] = [
  macro('wd', 'Crypto withdrawal pending', ['withdrawal_pending'], 'Hi {{user}}, your withdrawal is pending and will be processed within {{eta_time}}.', {
    triggers: ['my withdrawal is pending', 'cashout stuck'],
  }),
  macro('kyc', 'Account verification', ['kyc_verification'], 'Hi {{user}}, please upload a passport or ID card to verify your account.', {
    triggers: ['how do I verify my account'],
  }),
  macro('closure', 'Close account', ['account_closure'], 'Hi {{user}}, we can close your account after you withdraw your balance.', {
    triggers: ['close my account'],
  }),
];

const keyOf = (m: Macro): string => `${m.id}:v${m.version}`;

function analysisOf(intents: [Intent, number][] = [['general', 0.2]]): Analysis {
  return {
    intents: intents.map(([intent, score]) => ({ intent, score })),
    sentiment: 'neutral',
    sentimentScore: 0,
    urgency: 'normal',
    urgencyReasons: [],
    entities: [],
    questions: [],
    keywords: [],
    rgRisk: false,
    rgSignals: [],
    isLikelyNonEnglish: false,
    wordCount: 0,
    source: 'local',
  };
}

const OPTS = { maxResults: 3, minConfidence: 45 };

/** Non-builtin test embedder (so the cache is used) backed by builtin vectors; records what it embeds. */
class FakeEmbedder implements Embedder {
  readonly dim = 768;
  readonly passages: string[] = [];
  readonly queries: string[] = [];
  failPassages = false;
  failQueries = false;
  hangQueries = false;
  private readonly inner = createBuiltinEmbedder();

  constructor(
    readonly provider: Embedder['provider'] = 'ollama',
    readonly model = 'fake-embed',
  ) {}

  status() {
    return { provider: this.provider, model: this.model, state: 'ready' as const, detail: '' };
  }

  async init(): Promise<void> {}

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (kind === 'passage') {
      if (this.failPassages) throw new Error('embedding service down');
      this.passages.push(...texts);
    } else {
      if (this.failQueries) throw new Error('embedding service down');
      if (this.hangQueries) return new Promise(() => {});
      this.queries.push(...texts);
    }
    return this.inner.embed(texts, kind);
  }
}

class MapCache implements EmbeddingCache {
  readonly map = new Map<string, Float32Array>();
  get(model: string, key: string): Float32Array | null {
    return this.map.get(`${model}|${key}`) ?? null;
  }
  set(model: string, key: string, vector: Float32Array): void {
    this.map.set(`${model}|${key}`, vector);
  }
}

async function topIds(index: MacroIndex, message: string, intents?: [Intent, number][]): Promise<string[]> {
  return (await index.search(message, analysisOf(intents), OPTS)).recommendations.map((r) => r.macroId);
}

describe('MacroIndex maintenance', () => {
  it('never indexes archived macros', async () => {
    const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
    const archived = macro('old', 'Old withdrawal pending macro', ['withdrawal_pending'], 'withdrawal pending', {
      archivedAt: '2026-10-02T00:00:00.000Z',
    });
    await index.rebuild([...LIBRARY, archived], keyOf);
    expect(index.size()).toBe(3);
    expect(await topIds(index, 'old withdrawal pending macro')).not.toContain('old');

    await index.upsert({ ...LIBRARY[0]!, archivedAt: '2026-10-03T00:00:00.000Z' }, 'k');
    expect(index.size()).toBe(2);
    expect(await topIds(index, 'my withdrawal is pending')).not.toContain('wd');
  });

  it('adds, replaces and removes single macros', async () => {
    const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
    await index.rebuild(LIBRARY, keyOf);
    await index.upsert(macro('vip', 'VIP host', ['vip_program'], 'Your VIP host will contact you.'), 'vip:1');
    expect(index.size()).toBe(4);
    expect((await topIds(index, 'can I get a vip host'))[0]).toBe('vip');

    await index.upsert(macro('vip', 'Rakeback explained', ['bonus_inquiry'], 'Rakeback returns part of the house edge.'), 'vip:2');
    expect(index.size()).toBe(4);
    const res = await index.search('how does rakeback work', analysisOf(), OPTS);
    expect(res.recommendations[0]).toMatchObject({ macroId: 'vip', title: 'Rakeback explained' });

    index.remove('vip');
    index.remove('does-not-exist');
    expect(index.size()).toBe(3);
    expect(await topIds(index, 'how does rakeback work')).not.toContain('vip');
  });

  it('lets a remove() issued during a rebuild win', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new FakeEmbedder();
    const inner = slow.embed.bind(slow);
    slow.embed = async (texts, kind) => {
      if (kind === 'passage') await gate;
      return inner(texts, kind);
    };
    const index = new MacroIndex({ embedder: slow });
    const rebuilding = index.rebuild(LIBRARY, keyOf);
    index.remove('kyc');
    release();
    await rebuilding;
    expect(index.size()).toBe(2);
    expect(await topIds(index, 'how do I verify my account')).not.toContain('kyc');
  });

  it('returns an empty result for an empty index', async () => {
    const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
    const res = await index.search('my withdrawal is pending', analysisOf([['withdrawal_pending', 0.9]]), OPTS);
    expect(res).toEqual({ recommendations: [], noGoodMatch: true, uncoveredIntents: ['withdrawal_pending'] });
  });
});

describe('MacroIndex embeddings', () => {
  it('embeds only vectors missing from the cache', async () => {
    const cache = new MapCache();
    const first = new FakeEmbedder();
    await new MacroIndex({ embedder: first, cache }).rebuild(LIBRARY, keyOf);
    expect(first.passages).toHaveLength(6);
    expect([...cache.map.keys()]).toContain('ollama:fake-embed|wd:v1:head');
    expect([...cache.map.keys()]).toContain('ollama:fake-embed|wd:v1:body');

    const second = new FakeEmbedder();
    const index = new MacroIndex({ embedder: second, cache });
    await index.rebuild(LIBRARY, keyOf);
    expect(second.passages).toHaveLength(0);

    const edited = { ...LIBRARY[1]!, version: 2, title: 'Verify your account (KYC)' };
    await index.rebuild([LIBRARY[0]!, edited, LIBRARY[2]!], keyOf);
    expect(second.passages).toHaveLength(2);
    expect(second.passages[0]).toContain('Verify your account (KYC)');
  });

  it('ignores cached vectors of the wrong dimension and cache failures', async () => {
    const cache = new MapCache();
    cache.set('ollama:fake-embed', 'wd:v1:head', new Float32Array(3));
    const broken: EmbeddingCache = {
      get: (model, key) => {
        if (key.startsWith('kyc')) throw new Error('decryption failed');
        return cache.get(model, key);
      },
      set: () => {
        throw new Error('disk full');
      },
    };
    const embedder = new FakeEmbedder();
    const index = new MacroIndex({ embedder, cache: broken });
    await index.rebuild(LIBRARY, keyOf);
    expect(embedder.passages).toHaveLength(6);
    expect((await topIds(index, 'my withdrawal is pending'))[0]).toBe('wd');
  });

  it('does not cache builtin vectors', async () => {
    const cache = new MapCache();
    await new MacroIndex({ embedder: createBuiltinEmbedder(), cache }).rebuild(LIBRARY, keyOf);
    expect(cache.map.size).toBe(0);
  });

  it('setEmbedder re-embeds every macro and uses the new embedder for queries', async () => {
    const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
    await index.rebuild(LIBRARY, keyOf);
    const next = new FakeEmbedder('transformers', 'Xenova/bge-small-en-v1.5');
    await index.setEmbedder(next);
    expect(index.embedder).toBe(next);
    expect(next.passages).toHaveLength(6);
    expect(index.size()).toBe(3);
    expect((await topIds(index, 'my withdrawal is pending'))[0]).toBe('wd');
    expect(next.queries).toEqual(['my withdrawal is pending']);
  });

  it('keeps the current embedder when setEmbedder fails', async () => {
    const builtin = createBuiltinEmbedder();
    const index = new MacroIndex({ embedder: builtin });
    await index.rebuild(LIBRARY, keyOf);
    const failing = new FakeEmbedder();
    failing.failPassages = true;
    await expect(index.setEmbedder(failing)).rejects.toThrow('embedding service down');
    expect(index.embedder).toBe(builtin);
    expect((await topIds(index, 'my withdrawal is pending'))[0]).toBe('wd');
  });

  it('falls back to builtin vectors when the embedder fails while saving a macro', async () => {
    const fake = new FakeEmbedder();
    const index = new MacroIndex({ embedder: fake });
    await index.rebuild(LIBRARY, keyOf);
    fake.failPassages = true;
    await index.upsert(macro('vip', 'VIP host', ['vip_program'], 'Your VIP host will contact you.'), 'vip:1');
    expect(index.size()).toBe(4);
    expect(index.embedder.provider).toBe('builtin');
    expect(index.embedder.status().detail).toMatch(/Fell back to built-in vectors: ollama embeddings \(fake-embed\) failed/);
    expect((await topIds(index, 'can I get a vip host'))[0]).toBe('vip');
    expect((await topIds(index, 'my withdrawal is pending'))[0]).toBe('wd');
  });

  it('still recommends (lexical + intent) when the query cannot be embedded', async () => {
    const fake = new FakeEmbedder();
    const index = new MacroIndex({ embedder: fake, queryEmbedTimeoutMs: 50 });
    await index.rebuild(LIBRARY, keyOf);

    fake.failQueries = true;
    const failed = await index.search('my withdrawal is pending', analysisOf([['withdrawal_pending', 0.9]]), OPTS);
    expect(failed.recommendations[0]).toMatchObject({ macroId: 'wd', breakdown: { semantic: 0 } });
    expect(failed.recommendations[0]!.confidence).toBeGreaterThanOrEqual(75);

    fake.failQueries = false;
    fake.hangQueries = true;
    const started = performance.now();
    const slow = await index.search('my withdrawal is pending', analysisOf([['withdrawal_pending', 0.9]]), OPTS);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(slow.recommendations[0]?.macroId).toBe('wd');
  });
});

describe('MacroIndex recommendations', () => {
  it('respects maxResults and reports verification warnings', async () => {
    const outdated: Fact = {
      id: 'f1',
      macroId: 'wd',
      key: 'crypto.withdrawal.eta',
      statement: 'Withdrawals take up to 10 minutes',
      value: '10 minutes',
      sourceUrl: null,
      evidenceQuote: null,
      status: 'outdated',
      lastCheckedAt: '2026-10-02T00:00:00.000Z',
    };
    const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
    await index.rebuild([{ ...LIBRARY[0]!, verification: 'outdated', facts: [outdated] }, ...LIBRARY.slice(1)], keyOf);
    const res = await index.search('my withdrawal is pending', analysisOf([['withdrawal_pending', 0.9]]), { maxResults: 1, minConfidence: 45 });
    expect(res.recommendations).toHaveLength(1);
    const [best] = res.recommendations;
    expect(best).toMatchObject({ macroId: 'wd', verification: 'outdated', coversIntents: ['withdrawal_pending'] });
    expect(best!.warnings).toEqual(['1 fact(s) outdated: Withdrawals take up to 10 minutes']);
    expect(best!.reason).toMatch(/but some of its facts are outdated\.$/);
  });

  it('uses favorites and usage as a tie breaker', async () => {
    const twin = (id: string, extra: Partial<Macro>): Macro => macro(id, 'Withdrawal pending', ['withdrawal_pending'], 'Your withdrawal is pending.', extra);
    const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
    await index.rebuild([twin('a', {}), twin('b', { isFavorite: true }), twin('c', { useCount: 40 })], keyOf);
    const res = await index.search('withdrawal pending', analysisOf([['withdrawal_pending', 0.9]]), OPTS);
    // usage = 0.6 * log1p(uses)/log1p(maxUses) + 0.4 * favorite
    expect(res.recommendations.map((r) => r.macroId)).toEqual(['c', 'b', 'a']);
    expect(res.recommendations.map((r) => r.breakdown.usage)).toEqual([0.6, 0.4, 0]);
  });

  it('expands customer slang to the canonical vocabulary', async () => {
    const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
    await index.rebuild([macro('wd', 'Withdrawal delayed', ['withdrawal_pending'], 'Your withdrawal is being processed.'), ...LIBRARY.slice(1)], keyOf);
    const res = await index.search('where is my cash out??', analysisOf(), OPTS);
    expect(res.recommendations[0]?.macroId).toBe('wd');
    expect(res.recommendations[0]?.matchedTerms).toEqual(expect.arrayContaining(['cash out', 'withdrawal']));
  });
});
