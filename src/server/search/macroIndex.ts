/**
 * In-memory hybrid index over active macros: BM25/fuzzy lexical search (MiniSearch) + vector similarity
 * (Embedder) + intent match + usage prior. Everything lives in memory (decrypted), so search is ~ms.
 *
 * Consistency model: mutations that need embeddings (rebuild, upsert, setEmbedder) run one at a time in call
 * order and swap state in synchronously when done; remove() applies immediately and wins over any older
 * pending write of the same macro. Searches never wait for mutations.
 */
import type { Analysis, Id, Intent, Macro, Recommendation } from '../../shared/types.js';
import { listVariables } from '../../shared/template.js';
import { INTENT_LABELS } from '../../shared/types.js';
import { matchConcepts } from './concepts.js';
import { createFallbackEmbedder, type Embedder } from './embedder.js';
import { createLexicalIndex, searchLexical, toIndexDoc, type LexicalIndex } from './lexical.js';
import { buildLexicalQuery } from './query.js';
import { rankMacros, type IndexedMacro } from './ranker.js';
import { macroProducts, messageSignals } from './signals.js';
import { stripTemplateVariables } from './text.js';

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

const BODY_PASSAGE_CHARS = 800;
const EMBED_BATCH = 64;
/** A slow query embedding (e.g. Ollama loading its model) must not block recommendations. */
const DEFAULT_QUERY_EMBED_TIMEOUT_MS = 2000;

interface Entry extends IndexedMacro {
  /** Content key (HMAC) used for the embedding cache. */
  key: string;
}

interface IndexState {
  embedder: Embedder;
  entries: Map<Id, Entry>;
  lexical: LexicalIndex;
}

type Part = 'head' | 'body';

interface EmbedJob {
  entry: Entry;
  part: Part;
  text: string;
}

/** Passage describing what the macro is for: title, example questions, intent labels, tags. */
function headPassage(m: Macro): string {
  return [m.title, ...m.triggers, ...m.intents.map((i) => INTENT_LABELS[i]), ...m.tags].filter((s) => s.trim()).join('\n');
}

/** Passage with what the macro says: body without template variables, first 800 chars. */
function bodyPassage(m: Macro): string {
  return stripTemplateVariables(m.body).replace(/\s+/g, ' ').trim().slice(0, BODY_PASSAGE_CHARS);
}

/**
 * Concepts and products used by the relevance signals. `concepts` is what the macro says: title, triggers, tags,
 * body and the names of its template variables ({{bet_id}} -> "bet id": a macro that asks for the bet ID is about
 * bet IDs), but not its intent labels, which are scored by the intent component already. `headConcepts` (what the
 * macro is about, used for explanations) includes them.
 */
function relevanceFeatures(m: Macro, head: string, body: string): Pick<IndexedMacro, 'concepts' | 'headConcepts' | 'products'> {
  const variables = listVariables(m.body).map((v) => v.replace(/_/g, ' '));
  const content = [m.title, ...m.triggers, ...m.tags, body, ...variables].join('\n');
  return { concepts: new Set(matchConcepts(content).keys()), headConcepts: new Set(matchConcepts(head).keys()), products: macroProducts(m) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class MacroIndex {
  private state: IndexState;
  private readonly cache: EmbeddingCache | null;
  private readonly queryEmbedTimeoutMs: number;
  /** Tail of the mutation queue (rebuild/upsert/setEmbedder run one at a time). */
  private queue: Promise<unknown> = Promise.resolve();
  /** Monotonic operation counter; a remove() newer than a pending write cancels that write. */
  private seq = 0;
  private readonly removedAt = new Map<Id, number>();

  /** `queryEmbedTimeoutMs`: max wait for the query vector before ranking without it (default 2000). */
  constructor(opts: { embedder: Embedder; cache?: EmbeddingCache; queryEmbedTimeoutMs?: number }) {
    this.cache = opts.cache ?? null;
    this.queryEmbedTimeoutMs = opts.queryEmbedTimeoutMs ?? DEFAULT_QUERY_EMBED_TIMEOUT_MS;
    this.state = { embedder: opts.embedder, entries: new Map(), lexical: createLexicalIndex([]) };
  }

  get embedder(): Embedder {
    return this.state.embedder;
  }

  /** Swap the embedder and re-embed every macro. Rejects (keeping the current index) if the embedder fails. */
  async setEmbedder(embedder: Embedder): Promise<void> {
    await this.enqueue(() => this.reembedAll(embedder));
  }

  /** Replace the whole index. `keyOf(m)` returns a stable content key (HMAC) used for the embedding cache. */
  async rebuild(macros: Macro[], keyOf: (m: Macro) => string): Promise<void> {
    const seq = ++this.seq;
    const byId = new Map<Id, { macro: Macro; key: string }>();
    for (const macro of macros) if (!macro.archivedAt) byId.set(macro.id, { macro, key: keyOf(macro) });
    await this.enqueue(async () => {
      const { embedder, entries } = await this.embedWithFallback(this.state.embedder, [...byId.values()]);
      const kept = entries.filter((e) => !this.removedSince(e.macro.id, seq));
      this.state = {
        embedder,
        entries: new Map(kept.map((e) => [e.macro.id, e])),
        lexical: createLexicalIndex(kept.map((e) => e.macro)),
      };
      for (const [id, at] of this.removedAt) if (at <= seq) this.removedAt.delete(id);
    });
  }

  /** Add or replace one macro (archived macros must be removed instead). */
  async upsert(macro: Macro, key: string): Promise<void> {
    if (macro.archivedAt) {
      this.remove(macro.id);
      return;
    }
    const seq = ++this.seq;
    await this.enqueue(async () => {
      const { embedder, entries } = await this.embedWithFallback(this.state.embedder, [{ macro, key }]);
      if (embedder !== this.state.embedder) await this.reembedAll(embedder);
      const entry = entries[0];
      if (!entry || this.removedSince(macro.id, seq)) return;
      const { lexical, entries: current } = this.state;
      const doc = toIndexDoc(macro);
      if (lexical.has(macro.id)) lexical.replace(doc);
      else lexical.add(doc);
      current.set(macro.id, entry);
    });
  }

  remove(id: Id): void {
    this.removedAt.set(id, ++this.seq);
    const { entries, lexical } = this.state;
    entries.delete(id);
    if (lexical.has(id)) lexical.discard(id);
  }

  size(): number {
    return this.state.entries.size;
  }

  /**
   * Recommend macros for a customer message. Returns up to opts.maxResults recommendations, best first,
   * each with confidence 0..100, a one-sentence deterministic `reason`, matched terms, score breakdown and
   * verification warnings (from shared/verification.ts). Must complete in < 50 ms for 2,000 macros
   * (excluding the single query embedding call).
   */
  async search(message: string, analysis: Analysis, opts: SearchOptions): Promise<SearchResult> {
    let queryVector: Float32Array | null = null;
    // Retry once if the embedder was swapped while the query was being embedded (old vectors are gone).
    for (let attempt = 0; attempt < 2 && this.state.entries.size > 0; attempt++) {
      const embedder = this.state.embedder;
      queryVector = await this.embedQuery(embedder, message);
      if (this.state.embedder === embedder) break;
      queryVector = null;
    }
    // Rank against the latest state: remove()/upsert() may have run while the query was embedded.
    const state = this.state;
    const query = buildLexicalQuery(message);
    return rankMacros({
      entries: state.entries,
      provider: state.embedder.provider,
      queryVector,
      query,
      lexicalHits: searchLexical(state.lexical, query),
      analysis,
      signals: messageSignals(message, analysis),
      maxResults: opts.maxResults,
      minConfidence: opts.minConfidence,
    });
  }

  /**
   * Query vector, or null when the embedder fails or takes longer than `queryEmbedTimeoutMs`; search then
   * keeps working on lexical + intent signals.
   */
  private async embedQuery(embedder: Embedder, message: string): Promise<Float32Array | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.queryEmbedTimeoutMs);
    });
    const embedding = embedder.embed([message], 'query').then(
      ([vector]) => vector ?? null,
      () => null,
    );
    try {
      return await Promise.race([embedding, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private removedSince(id: Id, seq: number): boolean {
    return (this.removedAt.get(id) ?? -1) > seq;
  }

  /**
   * Embed with `embedder`; if a non-builtin provider fails (e.g. Ollama stopped), degrade to builtin vectors
   * so that saving a macro never fails because of the embedding service.
   */
  private async embedWithFallback(
    embedder: Embedder,
    items: { macro: Macro; key: string }[],
  ): Promise<{ embedder: Embedder; entries: Entry[] }> {
    try {
      return { embedder, entries: await this.embedMacros(embedder, items) };
    } catch (err) {
      if (embedder.provider === 'builtin') throw err;
      const fallback = createFallbackEmbedder(
        `Fell back to built-in vectors: ${embedder.provider} embeddings (${embedder.model}) failed. ${errorMessage(err)}`,
      );
      return { embedder: fallback, entries: await this.embedMacros(fallback, items) };
    }
  }

  /** Re-embed every current macro with `embedder` and swap it in; the lexical index is unchanged and shared. */
  private async reembedAll(embedder: Embedder): Promise<void> {
    const items = [...this.state.entries.values()].map(({ macro, key }) => ({ macro, key }));
    const entries = await this.embedMacros(embedder, items);
    const current = this.state;
    // Macros removed while embedding are already gone from `current`.
    const kept = entries.filter((e) => current.entries.has(e.macro.id));
    this.state = { embedder, entries: new Map(kept.map((e) => [e.macro.id, e])), lexical: current.lexical };
  }

  /**
   * Build index entries with head/body vectors. Cached vectors are reused (cache key `${key}:head|body`, model
   * `${provider}:${model}`); missing ones are embedded in batches and stored. Builtin vectors are not cached:
   * recomputing them (~0.1 ms) is cheaper than decrypting a cached copy.
   */
  private async embedMacros(embedder: Embedder, items: { macro: Macro; key: string }[]): Promise<Entry[]> {
    await embedder.init();
    const cache = embedder.provider === 'builtin' ? null : this.cache;
    const model = `${embedder.provider}:${embedder.model}`;
    const entries: Entry[] = [];
    const jobs: EmbedJob[] = [];
    for (const { macro, key } of items) {
      const head = headPassage(macro);
      const body = bodyPassage(macro);
      const entry: Entry = { macro, key, head: null, body: null, ...relevanceFeatures(macro, head, body) };
      entries.push(entry);
      for (const [part, text] of [['head', head], ['body', body]] as const) {
        if (!text) continue;
        const cached = cache ? readCache(cache, model, `${key}:${part}`, embedder.dim) : null;
        if (cached) entry[part] = cached;
        else jobs.push({ entry, part, text });
      }
    }
    for (let i = 0; i < jobs.length; i += EMBED_BATCH) {
      const batch = jobs.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embed(batch.map((j) => j.text), 'passage');
      batch.forEach((job, k) => {
        const vector = vectors[k];
        if (!vector) return;
        job.entry[job.part] = vector;
        if (cache) writeCache(cache, model, `${job.entry.key}:${job.part}`, vector);
      });
    }
    return entries;
  }
}

/** Cached vector, or null when missing, unreadable or of the wrong dimension. */
function readCache(cache: EmbeddingCache, model: string, key: string, dim: number): Float32Array | null {
  try {
    const v = cache.get(model, key);
    return v && (dim === 0 || v.length === dim) ? v : null;
  } catch {
    return null;
  }
}

/** The cache is an optimization: a failed write must not fail indexing. */
function writeCache(cache: EmbeddingCache, model: string, key: string, vector: Float32Array): void {
  try {
    cache.set(model, key, vector);
  } catch {
    // ignored on purpose
  }
}
