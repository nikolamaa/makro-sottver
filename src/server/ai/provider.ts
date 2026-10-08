/**
 * LLM providers. Only two are supported: Anthropic (cloud, paid, default model claude-haiku-5-5 - the cheapest)
 * and Ollama (local, free). Both return validated JSON through zod schemas.
 */
import type { z } from 'zod';
import type { AiEffort, LlmUsage } from '../../shared/types.js';

export type LlmPurpose = 'analyze' | 'rerank' | 'personalize' | 'draft' | 'fact_check' | 'macro_update' | 'test';

export interface JsonRequest<S extends z.ZodType> {
  purpose: LlmPurpose;
  system: string;
  user: string;
  schema: S;
  /** Must leave room for adaptive thinking on Haiku 5.5 (use >= 2048). */
  maxTokens: number;
  effort: AiEffort;
  /** Abort after this many ms (default 20000). */
  timeoutMs?: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
}

export type AiErrorCode =
  | 'not_configured'
  | 'budget_exceeded'
  | 'strict_local'
  | 'refusal'
  | 'invalid_output'
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'unknown';

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface LlmProvider {
  readonly id: 'anthropic' | 'ollama';
  readonly model: string;
  /** True when requests leave the computer. */
  readonly isCloud: boolean;
  generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<LlmResult<z.infer<S>>>;
  /** Cheap connectivity/auth check. */
  test(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Anthropic provider using the official SDK (@anthropic-ai/sdk): client.messages.parse() with
 * output_config: { format: zodOutputFormat(schema), effort }, thinking left at default (adaptive), no
 * temperature/top_p/top_k (they 400 on Haiku 5.5), no assistant prefill. Read content blocks by type.
 * Handle stop_reason 'refusal' -> AiError('refusal'), 'max_tokens' -> AiError('invalid_output').
 * Map SDK errors: AuthenticationError->auth, RateLimitError->rate_limit, APIConnectionError->network,
 * APIConnectionTimeoutError->timeout. maxRetries 1. Cost via priceFor(model).
 */
export function createAnthropicProvider(opts: { apiKey: string; model: string }): LlmProvider {
  throw new Error('TODO');
}

/**
 * Ollama provider: POST {url}/api/chat with { model, stream: false, format: <JSON schema from z.toJSONSchema>,
 * messages: [{role:'system'},{role:'user'}], options: { temperature: 0.2 } }. Validate with schema.safeParse.
 * Usage from prompt_eval_count / eval_count; costUsd = 0. test() calls GET {url}/api/tags and checks the model exists.
 */
export function createOllamaProvider(opts: { url: string; model: string }): LlmProvider {
  throw new Error('TODO');
}

/** USD per 1M tokens. Unknown models fall back to the Haiku 5.5 rates. */
export function priceFor(model: string): { inputPerMTok: number; outputPerMTok: number } {
  const table: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
    'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  };
  return table[model] ?? { inputPerMTok: 0.1, outputPerMTok: 0.5 };
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}
