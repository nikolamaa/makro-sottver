import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  cosine,
  createBuiltinEmbedder,
  createOllamaEmbedder,
  createTransformersEmbedder,
  resolveEmbedder,
  tensorToVectors,
} from './embedder.js';

const embedOne = async (text: string): Promise<Float32Array> => (await createBuiltinEmbedder().embed([text], 'passage'))[0]!;

function norm(v: Float32Array): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function moduleNotFound(): Error {
  return Object.assign(new Error("Cannot find package '@huggingface/transformers' imported from embedder.js"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
}

/** Fake @huggingface/transformers: each text becomes [length, 1, 0, 0] (not normalized, to test normalization). */
function fakeTransformers(shape: 'tolist' | 'data' = 'tolist') {
  const calls: string[][] = [];
  const extractor = vi.fn(async (texts: string[], options: { pooling: string; normalize: boolean }) => {
    expect(options).toEqual({ pooling: 'cls', normalize: true });
    calls.push(texts);
    const rows = texts.map((t) => [t.length, 1, 0, 0]);
    return shape === 'tolist' ? { tolist: () => rows } : { data: Float32Array.from(rows.flat()), dims: [rows.length, 4] };
  });
  const mod = { env: {} as Record<string, unknown>, pipeline: vi.fn(async () => extractor) };
  return { mod, extractor, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('builtin embedder', () => {
  it('is ready immediately with a fixed model id and dimension', () => {
    const e = createBuiltinEmbedder();
    expect(e.provider).toBe('builtin');
    expect(e.model).toBe('builtin-v1');
    expect(e.dim).toBe(768);
    expect(e.status()).toMatchObject({ provider: 'builtin', model: 'builtin-v1', state: 'ready' });
  });

  it('is deterministic and L2-normalized', async () => {
    const e = createBuiltinEmbedder();
    const [a, b] = await e.embed(['My BTC withdrawal is pending', 'My BTC withdrawal is pending'], 'query');
    expect(a).toHaveLength(768);
    expect(Array.from(a!)).toEqual(Array.from(b!));
    expect(norm(a!)).toBeCloseTo(1, 5);
  });

  it('returns a zero vector for text without content words', async () => {
    const v = await embedOne('hi, thanks!');
    expect(norm(v)).toBe(0);
  });

  it('maps synonyms and typos close together and unrelated text far apart', async () => {
    const typo = await embedOne('withdrawl pendng');
    expect(cosine(typo, await embedOne('withdrawal pending'))).toBeGreaterThan(0.6);
    expect(cosine(typo, await embedOne('deposit missing'))).toBeLessThan(0.2);
    expect(cosine(await embedOne('my cashout is stuck'), await embedOne('Withdrawal pending'))).toBeGreaterThan(0.5);
    expect(cosine(await embedOne("what's the weather in Paris tomorrow"), await embedOne('Withdrawal pending'))).toBeLessThan(0.1);
  });
});

describe('transformers embedder', () => {
  it('rejects with a clear message when the optional package is missing', async () => {
    const e = createTransformersEmbedder({ cacheDir: '/tmp/models', loadModule: () => Promise.reject(moduleNotFound()) });
    await expect(e.init()).rejects.toThrow(/@huggingface\/transformers.*not installed/);
    expect(e.status()).toMatchObject({ provider: 'transformers', state: 'error' });
    expect(e.status().detail).toMatch(/not installed/);
    expect(e.dim).toBe(0);
    await expect(e.embed(['x'], 'query')).rejects.toThrow(/not installed/);
  });

  const installed = (() => {
    try {
      createRequire(import.meta.url).resolve('@huggingface/transformers');
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(installed)('fails gracefully with the real dynamic import when the package is not installed', async () => {
    const e = createTransformersEmbedder({ cacheDir: '/tmp/models' });
    await expect(e.init()).rejects.toThrow(/not installed/);
    expect(e.status().state).toBe('error');
  });

  it('loads the pipeline once with the expected options and embeds in batches', async () => {
    const { mod, extractor, calls } = fakeTransformers();
    const e = createTransformersEmbedder({ cacheDir: '/data/models', loadModule: async () => mod });
    await Promise.all([e.init(), e.init()]);
    expect(mod.pipeline).toHaveBeenCalledTimes(1);
    expect(mod.pipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'q8' });
    expect(mod.env).toMatchObject({ cacheDir: '/data/models', allowRemoteModels: true });
    expect(e.dim).toBe(4);
    expect(e.status()).toMatchObject({ state: 'ready', model: 'Xenova/bge-small-en-v1.5' });

    extractor.mockClear();
    calls.length = 0;
    const texts = Array.from({ length: 70 }, (_, i) => `passage ${i}`);
    const vectors = await e.embed(texts, 'passage');
    expect(vectors).toHaveLength(70);
    expect(calls.map((c) => c.length)).toEqual([32, 32, 6]);
    for (const v of vectors) expect(norm(v)).toBeCloseTo(1, 5);
  });

  it('prefixes queries with the BGE instruction', async () => {
    const { mod, calls } = fakeTransformers();
    const e = createTransformersEmbedder({ cacheDir: '/m', loadModule: async () => mod });
    await e.embed(['where is my withdrawal'], 'query');
    expect(calls.at(-1)).toEqual(['Represent this sentence for searching relevant passages: where is my withdrawal']);
  });

  it('accepts tensors exposing data + dims and modules wrapped in a default export', async () => {
    const { mod } = fakeTransformers('data');
    const e = createTransformersEmbedder({ cacheDir: '/m', loadModule: async () => ({ default: mod }) });
    const [v] = await e.embed(['abc'], 'passage');
    expect(v).toHaveLength(4);
    expect(norm(v!)).toBeCloseTo(1, 5);
  });

  it('reports model download/load failures', async () => {
    const mod = { env: {}, pipeline: vi.fn(async () => Promise.reject(new Error('fetch failed'))) };
    const e = createTransformersEmbedder({ cacheDir: '/m', model: 'Xenova/other', loadModule: async () => mod });
    await expect(e.init()).rejects.toThrow('Could not load the embedding model Xenova/other: fetch failed');
    expect(e.status().state).toBe('error');
  });

  it('rejects unexpected tensor shapes', () => {
    expect(() => tensorToVectors({ data: [1, 2, 3], dims: [2, 2] }, 2)).toThrow(/Unexpected output shape/);
    expect(() => tensorToVectors(null, 1)).toThrow(/Unexpected output shape/);
  });
});

describe('ollama embedder', () => {
  it('posts to /api/embed, normalizes vectors and discovers the dimension', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return jsonResponse({ embeddings: body.input.map(() => [3, 4, 0]) });
    });
    const e = createOllamaEmbedder({ url: 'http://127.0.0.1:11434/', model: 'nomic-embed-text', fetch: fetchMock });
    await e.init();
    expect(e.dim).toBe(3);
    expect(e.status()).toMatchObject({ provider: 'ollama', model: 'nomic-embed-text', state: 'ready' });

    const [v] = await e.embed(['my deposit is missing'], 'query');
    expect(Array.from(v!)).toEqual([expect.closeTo(0.6, 5), expect.closeTo(0.8, 5), 0]);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('http://127.0.0.1:11434/api/embed');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'nomic-embed-text',
      input: ['search_query: my deposit is missing'],
      keep_alive: '30m',
    });
  });

  it('uses the global fetch by default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ embeddings: [[1, 0]] }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const e = createOllamaEmbedder({ url: 'http://localhost:11434', model: 'all-minilm' });
      await e.init();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(e.dim).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces HTTP errors and unreachable servers', async () => {
    const notFound = createOllamaEmbedder({
      url: 'http://127.0.0.1:11434',
      model: 'missing-model',
      fetch: async () => jsonResponse({ error: 'model "missing-model" not found, try pulling it first' }, 404),
    });
    await expect(notFound.init()).rejects.toThrow(/HTTP 404.*not found/);
    expect(notFound.status().state).toBe('error');

    const down = createOllamaEmbedder({
      url: 'http://127.0.0.1:11434',
      model: 'nomic-embed-text',
      fetch: async () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(down.init()).rejects.toThrow(/not reachable/);
  });

  it('rejects malformed responses', async () => {
    const e = createOllamaEmbedder({ url: 'http://x', model: 'm', fetch: async () => jsonResponse({ embedding: [1, 2] }) });
    await expect(e.init()).rejects.toThrow(/unexpected response/);
  });
});

describe('resolveEmbedder', () => {
  const base = { cacheDir: '/m', ollamaUrl: 'http://127.0.0.1:11434' };

  it('returns builtin when asked', async () => {
    const e = await resolveEmbedder({ provider: 'builtin', ollamaModel: 'nomic-embed-text' }, base);
    expect(e.provider).toBe('builtin');
  });

  it("'auto' falls back to builtin with an explanation when transformers is missing", async () => {
    const log = vi.fn();
    const e = await resolveEmbedder(
      { provider: 'auto', ollamaModel: 'nomic-embed-text' },
      { ...base, log, loadTransformers: () => Promise.reject(moduleNotFound()) },
    );
    expect(e.provider).toBe('builtin');
    expect(e.status().state).toBe('ready');
    expect(e.status().detail).toMatch(/not available.*not installed/);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("'auto' uses transformers when it initializes", async () => {
    const { mod } = fakeTransformers();
    const e = await resolveEmbedder({ provider: 'auto', ollamaModel: 'x' }, { ...base, loadTransformers: async () => mod });
    expect(e.provider).toBe('transformers');
    expect(e.status().state).toBe('ready');
  });

  it("'transformers' and 'ollama' fall back to builtin when they fail, without throwing", async () => {
    const t = await resolveEmbedder({ provider: 'transformers', ollamaModel: 'x' }, { ...base, loadTransformers: () => Promise.reject(new Error('boom')) });
    expect(t.provider).toBe('builtin');
    expect(t.status().detail).toMatch(/^Fell back to built-in vectors.*boom/);

    const o = await resolveEmbedder(
      { provider: 'ollama', ollamaModel: 'nomic-embed-text' },
      { ...base, fetch: async () => Promise.reject(new TypeError('fetch failed')) },
    );
    expect(o.provider).toBe('builtin');
    expect(o.status().detail).toMatch(/Ollama embeddings \(nomic-embed-text\) failed/);
  });

  it("'ollama' returns the ollama embedder when the server answers", async () => {
    const e = await resolveEmbedder(
      { provider: 'ollama', ollamaModel: 'nomic-embed-text' },
      { ...base, fetch: async () => jsonResponse({ embeddings: [[0, 1]] }) },
    );
    expect(e.provider).toBe('ollama');
    expect(e.dim).toBe(2);
  });
});
