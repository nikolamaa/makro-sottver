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

export function createBuiltinEmbedder(): Embedder {
  throw new Error('TODO');
}

export function createTransformersEmbedder(opts: { cacheDir: string; model?: string }): Embedder {
  throw new Error('TODO');
}

export function createOllamaEmbedder(opts: { url: string; model: string }): Embedder {
  throw new Error('TODO');
}

/**
 * Pick and initialize an embedder according to settings. Never throws:
 *  - 'builtin' -> builtin
 *  - 'transformers' / 'ollama' -> that provider, or builtin (status.detail explains the fallback) if init fails
 *  - 'auto' -> transformers if it initializes, otherwise builtin
 */
export async function resolveEmbedder(
  settings: AppSettings['embeddings'],
  opts: { cacheDir: string; ollamaUrl: string; log?: (msg: string) => void },
): Promise<Embedder> {
  throw new Error('TODO');
}

/** Cosine similarity of two L2-normalized vectors (= dot product). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
