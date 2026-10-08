/**
 * In-memory hybrid index over active macros: BM25/fuzzy lexical search (MiniSearch) + vector similarity
 * (Embedder) + intent match + usage prior. Everything lives in memory (decrypted), so search is ~ms.
 */
import type { Analysis, Id, Intent, Macro, Recommendation } from '../../shared/types.js';
import type { Embedder } from './embedder.js';

export interface EmbeddingCache {
  get(model: string, key: string): Float32Array | null;
  set(model: string, key: string, vector: Float32Array): void;
}

export interface SearchOptions {
  maxResults: number;
  /** 0..100; when the best confidence is below this, noGoodMatch = true (recommendations are still returned). */
  minConfidence: number;
}

export interface SearchResult {
  recommendations: Recommendation[];
  noGoodMatch: boolean;
  /** Intents from analysis.questions/intents (score >= 0.35) not covered by any returned macro's intents. */
  uncoveredIntents: Intent[];
}

export class MacroIndex {
  constructor(opts: { embedder: Embedder; cache?: EmbeddingCache }) {
    throw new Error('TODO');
  }

  get embedder(): Embedder {
    throw new Error('TODO');
  }

  /** Swap the embedder and re-embed every macro. */
  async setEmbedder(embedder: Embedder): Promise<void> {
    throw new Error('TODO');
  }

  /** Replace the whole index. `keyOf(m)` returns a stable content key (HMAC) used for the embedding cache. */
  async rebuild(macros: Macro[], keyOf: (m: Macro) => string): Promise<void> {
    throw new Error('TODO');
  }

  /** Add or replace one macro (archived macros must be removed instead). */
  async upsert(macro: Macro, key: string): Promise<void> {
    throw new Error('TODO');
  }

  remove(id: Id): void {
    throw new Error('TODO');
  }

  size(): number {
    throw new Error('TODO');
  }

  /**
   * Recommend macros for a customer message. Returns up to opts.maxResults recommendations, best first,
   * each with confidence 0..100, a one-sentence deterministic `reason`, matched terms, score breakdown and
   * verification warnings (from shared/verification.ts). Must complete in < 50 ms for 2,000 macros
   * (excluding the single query embedding call).
   */
  async search(message: string, analysis: Analysis, opts: SearchOptions): Promise<SearchResult> {
    throw new Error('TODO');
  }
}
