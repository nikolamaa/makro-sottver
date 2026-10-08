/**
 * Embedding providers. All vectors returned are L2-normalized Float32Arrays of length `dim`.
 *
 * - builtin:      zero-dependency "concept + character n-gram" hashing vectorizer (always available, < 1 ms).
 * - transformers: @huggingface/transformers (optional dependency) running Xenova/bge-small-en-v1.5 (q8) on CPU.
 *                 Model files are downloaded once into `cacheDir`. Queries are prefixed with the BGE query
 *                 instruction "Represent this sentence for searching relevant passages: ".
 * - ollama:       local Ollama server, POST {url}/api/embed {model, input}.
 */
import type { AppSettings, EmbedderStatus } from '../../shared/types.js';
import { BUILTIN_DIM, BUILTIN_MODEL, vectorize } from './vectorizer.js';

export type EmbedKind = 'query' | 'passage';

export interface Embedder {
  readonly provider: EmbedderStatus['provider'];
  readonly model: string;
  /** 0 until init() succeeded for providers whose dimension is discovered at runtime. */
  readonly dim: number;
  status(): EmbedderStatus;
  /** Load the model / check connectivity. Rejects when unavailable. Idempotent. */
  init(): Promise<void>;
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
}

export const DEFAULT_TRANSFORMERS_MODEL = 'Xenova/bge-small-en-v1.5';
const TRANSFORMERS_PACKAGE = '@huggingface/transformers';
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const TRANSFORMERS_BATCH = 32;
const OLLAMA_BATCH = 32;
const OLLAMA_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Copy into a Float32Array and L2-normalize; rejects empty or non-finite vectors. */
function toUnitVector(values: ArrayLike<number>): Float32Array {
  const v = Float32Array.from(values);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  if (v.length === 0 || !Number.isFinite(sum)) throw new Error('Embedding model returned an invalid vector');
  if (sum > 0) {
    const inv = 1 / Math.sqrt(sum);
    for (let i = 0; i < v.length; i++) v[i]! *= inv;
  }
  return v;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Lifecycle shared by the runtime-loaded providers: state + detail for status(), a single in-flight init()
 * promise (retried after a failure) and the discovered vector dimension.
 */
class Lifecycle {
  state: EmbedderStatus['state'] = 'loading';
  detail: string;
  dim = 0;
  private pending: Promise<void> | null = null;

  constructor(initialDetail: string) {
    this.detail = initialDetail;
  }

  run(load: () => Promise<number>, readyDetail: () => string): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.pending) return this.pending;
    this.state = 'loading';
    this.pending = load().then(
      (dim) => {
        this.dim = dim;
        this.state = 'ready';
        this.detail = readyDetail();
        this.pending = null;
      },
      (err: unknown) => {
        this.state = 'error';
        this.detail = errorMessage(err);
        this.pending = null;
        throw err instanceof Error ? err : new Error(String(err));
      },
    );
    return this.pending;
  }
}

// ---------------------------------------------------------------------------
// builtin
// ---------------------------------------------------------------------------

function builtinEmbedder(detail: string): Embedder {
  return {
    provider: 'builtin',
    model: BUILTIN_MODEL,
    dim: BUILTIN_DIM,
    status: () => ({ provider: 'builtin', model: BUILTIN_MODEL, state: 'ready', detail }),
    init: () => Promise.resolve(),
    embed: (texts) => Promise.resolve(texts.map(vectorize)),
  };
}

/** Always-available, deterministic hashing embedder (model id 'builtin-v1', dim 768). */
export function createBuiltinEmbedder(): Embedder {
  return builtinEmbedder('Built-in keyword/concept vectors (no download needed).');
}

/** Builtin embedder whose status detail explains why the preferred provider is not in use. */
export function createFallbackEmbedder(detail: string): Embedder {
  return builtinEmbedder(detail);
}

// ---------------------------------------------------------------------------
// transformers (optional dependency, loaded lazily)
// ---------------------------------------------------------------------------

/** The subset of @huggingface/transformers used here, checked at runtime. */
interface TransformersModule {
  env: Record<string, unknown>;
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>;
}

type FeatureExtractor = (texts: string[], options: { pooling: 'cls'; normalize: boolean }) => Promise<unknown>;

interface TensorLike {
  tolist?: () => unknown;
  data?: ArrayLike<number>;
  dims?: readonly number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asTransformersModule(mod: unknown): TransformersModule {
  const candidate = isRecord(mod) && isRecord(mod.default) && !('pipeline' in mod) ? mod.default : mod;
  if (!isRecord(candidate) || typeof candidate.pipeline !== 'function' || !isRecord(candidate.env)) {
    throw new Error(`${TRANSFORMERS_PACKAGE} does not export pipeline()/env; the installed version is not supported`);
  }
  return candidate as unknown as TransformersModule;
}

function isModuleNotFound(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const code = err.code;
  const message = typeof err.message === 'string' ? err.message : '';
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find (?:package|module)/i.test(message);
}

/** Default loader: a variable specifier keeps bundlers/tsc from resolving the optional package. */
async function importTransformers(): Promise<unknown> {
  const specifier: string = TRANSFORMERS_PACKAGE;
  return import(specifier);
}

/** Convert a pipeline output (Tensor with tolist(), or data + dims) to one vector per input text. */
export function tensorToVectors(output: unknown, count: number): Float32Array[] {
  const tensor: TensorLike = isRecord(output) ? (output as TensorLike) : {};
  if (typeof tensor.tolist === 'function') {
    const list = tensor.tolist();
    if (Array.isArray(list) && list.length === count && list.every((row) => Array.isArray(row))) {
      return (list as number[][]).map(toUnitVector);
    }
  }
  const { data, dims } = tensor;
  const width = dims?.[1] ?? 0;
  if (data && dims && dims.length === 2 && dims[0] === count && data.length === count * width) {
    const vectors: Float32Array[] = [];
    for (let i = 0; i < count; i++) {
      const row = new Float32Array(width);
      for (let j = 0; j < width; j++) row[j] = data[i * width + j] ?? 0;
      vectors.push(toUnitVector(row));
    }
    return vectors;
  }
  throw new Error('Unexpected output shape from the feature-extraction pipeline');
}

/**
 * Local neural embeddings via @huggingface/transformers (default model Xenova/bge-small-en-v1.5, q8, CLS pooling).
 * `loadModule` is injectable for tests; by default the optional package is imported dynamically.
 */
export function createTransformersEmbedder(opts: {
  cacheDir: string;
  model?: string;
  loadModule?: () => Promise<unknown>;
}): Embedder {
  const model = opts.model ?? DEFAULT_TRANSFORMERS_MODEL;
  const loadModule = opts.loadModule ?? importTransformers;
  const life = new Lifecycle(`Loading ${model}...`);
  let extractor: FeatureExtractor | null = null;

  const runBatch = async (texts: string[]): Promise<Float32Array[]> => {
    if (!extractor) throw new Error('Embedding model is not loaded');
    return tensorToVectors(await extractor(texts, { pooling: 'cls', normalize: true }), texts.length);
  };

  const load = async (): Promise<number> => {
    let mod: TransformersModule;
    try {
      mod = asTransformersModule(await loadModule());
    } catch (err) {
      if (isModuleNotFound(err)) {
        throw new Error(`Local neural embeddings need the optional package ${TRANSFORMERS_PACKAGE}, which is not installed (npm install ${TRANSFORMERS_PACKAGE}).`);
      }
      throw err;
    }
    mod.env.cacheDir = opts.cacheDir;
    mod.env.allowRemoteModels = true;
    let pipe: unknown;
    try {
      pipe = await mod.pipeline('feature-extraction', model, { dtype: 'q8' });
    } catch (err) {
      throw new Error(`Could not load the embedding model ${model}: ${errorMessage(err)}`);
    }
    if (typeof pipe !== 'function') throw new Error(`The ${model} pipeline is not callable`);
    extractor = pipe as FeatureExtractor;
    const [probe] = await runBatch(['ping']);
    return probe?.length ?? 0;
  };

  const embedder: Embedder = {
    provider: 'transformers',
    model,
    get dim() {
      return life.dim;
    },
    status: () => ({ provider: 'transformers', model, state: life.state, detail: life.detail }),
    init: () => life.run(load, () => `Local neural model ${model} (${life.dim} dimensions).`),
    async embed(texts, kind) {
      await embedder.init();
      const inputs = kind === 'query' ? texts.map((t) => BGE_QUERY_PREFIX + t) : texts;
      const out: Float32Array[] = [];
      for (const batch of chunk(inputs, TRANSFORMERS_BATCH)) out.push(...(await runBatch(batch)));
      return out;
    },
  };
  return embedder;
}

// ---------------------------------------------------------------------------
// ollama
// ---------------------------------------------------------------------------

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Task prefixes some popular Ollama embedding models expect (they are not added by Ollama itself). */
function ollamaPrefixes(model: string): Record<EmbedKind, string> {
  if (/nomic-embed/i.test(model)) return { query: 'search_query: ', passage: 'search_document: ' };
  if (/mxbai-embed|bge/i.test(model)) return { query: BGE_QUERY_PREFIX, passage: '' };
  return { query: '', passage: '' };
}

function parseOllamaEmbeddings(body: unknown, count: number): Float32Array[] {
  const embeddings = isRecord(body) ? body.embeddings : undefined;
  if (!Array.isArray(embeddings) || embeddings.length !== count) {
    throw new Error('Ollama returned an unexpected response (missing "embeddings")');
  }
  return embeddings.map((row: unknown) => {
    if (!Array.isArray(row) || !row.every((x) => typeof x === 'number')) throw new Error('Ollama returned a malformed embedding');
    return toUnitVector(row as number[]);
  });
}

/** Embeddings from a local Ollama server (POST {url}/api/embed). `fetch` is injectable for tests. */
export function createOllamaEmbedder(opts: { url: string; model: string; fetch?: FetchLike }): Embedder {
  const { model } = opts;
  const endpoint = `${opts.url.replace(/\/+$/, '')}/api/embed`;
  const prefixes = ollamaPrefixes(model);
  const life = new Lifecycle(`Connecting to Ollama (${model})...`);

  const request = async (input: string[]): Promise<Float32Array[]> => {
    const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Ollama is not reachable at ${opts.url}: ${errorMessage(err)}`);
    }
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const reason = isRecord(body) && typeof body.error === 'string' ? body.error.slice(0, 200) : res.statusText;
      throw new Error(`Ollama embedding request failed (HTTP ${res.status}): ${reason}`);
    }
    return parseOllamaEmbeddings(await res.json(), input.length);
  };

  const embedder: Embedder = {
    provider: 'ollama',
    model,
    get dim() {
      return life.dim;
    },
    status: () => ({ provider: 'ollama', model, state: life.state, detail: life.detail }),
    init: () =>
      life.run(
        async () => (await request(['ping']))[0]?.length ?? 0,
        () => `Ollama model ${model} (${life.dim} dimensions).`,
      ),
    async embed(texts, kind) {
      await embedder.init();
      const prefix = prefixes[kind];
      const out: Float32Array[] = [];
      for (const batch of chunk(texts, OLLAMA_BATCH)) out.push(...(await request(batch.map((t) => prefix + t))));
      return out;
    },
  };
  return embedder;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface ResolveEmbedderOptions {
  cacheDir: string;
  ollamaUrl: string;
  log?: (msg: string) => void;
  /** Test seam: replaces the dynamic import of @huggingface/transformers. */
  loadTransformers?: () => Promise<unknown>;
  /** Test seam: replaces global fetch for Ollama. */
  fetch?: FetchLike;
}

async function tryInit(embedder: Embedder): Promise<string | null> {
  try {
    await embedder.init();
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

/**
 * Pick and initialize an embedder according to settings. Never throws:
 *  - 'builtin' -> builtin
 *  - 'transformers' / 'ollama' -> that provider, or builtin (status.detail explains the fallback) if init fails
 *  - 'auto' -> transformers if it initializes, otherwise builtin
 */
export async function resolveEmbedder(settings: AppSettings['embeddings'], opts: ResolveEmbedderOptions): Promise<Embedder> {
  const log = opts.log ?? (() => {});
  if (settings.provider === 'builtin') return createBuiltinEmbedder();

  const preferred =
    settings.provider === 'ollama'
      ? createOllamaEmbedder({ url: opts.ollamaUrl, model: settings.ollamaModel, fetch: opts.fetch })
      : createTransformersEmbedder({ cacheDir: opts.cacheDir, loadModule: opts.loadTransformers });
  const failure = await tryInit(preferred);
  if (failure === null) return preferred;

  const label = preferred.provider === 'ollama' ? `Ollama embeddings (${preferred.model})` : `Local neural embeddings (${preferred.model})`;
  const detail =
    settings.provider === 'auto'
      ? `Using built-in vectors: ${label} not available. ${failure}`
      : `Fell back to built-in vectors: ${label} failed. ${failure}`;
  log(detail);
  return createFallbackEmbedder(detail);
}

/** Cosine similarity of two L2-normalized vectors (= dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
