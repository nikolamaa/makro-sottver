/**
 * LLM providers. Only two are supported: Anthropic (cloud, paid, default model claude-haiku-5-5 - the cheapest)
 * and Ollama (local, free). Both return validated JSON through zod schemas.
 */
import { performance } from 'node:perf_hooks';
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  type AutoParseableOutputFormat,
} from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
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
    /** Tokens billed by a call that still failed (refusal, cut-off or invalid output), so spend stays accurate. */
    readonly usage: LlmUsage | null = null,
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

const DEFAULT_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 10_000;
const MIN_MAX_TOKENS = 2048;

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/** Result of parsing the model's JSON text; failures are reported as data so stop_reason can be checked first. */
type SafeParsed<T> = { ok: true; data: T } | { ok: false };

const anthropicFormats = new WeakMap<z.ZodType, AutoParseableOutputFormat<SafeParsed<unknown>>>();

/**
 * zodOutputFormat() whose parse never throws. messages.parse() parses the text block before returning, so with
 * the stock format a refusal or truncated answer (partial JSON) would surface as a generic parse exception
 * instead of its stop_reason. Cached per schema because building the JSON schema is not free.
 */
function safeOutputFormat<S extends z.ZodType>(schema: S): AutoParseableOutputFormat<SafeParsed<z.infer<S>>> {
  let format = anthropicFormats.get(schema);
  if (!format) {
    const strict = zodOutputFormat(schema);
    format = {
      type: strict.type,
      schema: strict.schema,
      parse: (text: string): SafeParsed<unknown> => {
        try {
          return { ok: true, data: strict.parse(text) };
        } catch {
          return { ok: false };
        }
      },
    };
    anthropicFormats.set(schema, format);
  }
  return format as AutoParseableOutputFormat<SafeParsed<z.infer<S>>>;
}

interface AnthropicUsageBlock {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

function anthropicUsage(model: string, u: AnthropicUsageBlock, latencyMs: number): LlmUsage {
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  return {
    provider: 'anthropic',
    model,
    inputTokens: u.input_tokens + cacheWrite + cacheRead,
    outputTokens: u.output_tokens,
    costUsd: anthropicCostUsd(model, { input: u.input_tokens, cacheWrite, cacheRead, output: u.output_tokens }),
    latencyMs: Math.round(latencyMs),
  };
}

function apiErrorDetail(err: APIError): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === 'string' ? message.slice(0, 300) : `HTTP ${err.status ?? 'error'}`;
}

/** Maps SDK errors (typed classes, most specific first) to AiError with a message fit for the UI. */
function toAnthropicError(err: unknown, model: string): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof AuthenticationError) return new AiError('auth', 'Anthropic rejected the API key. Check the key in Settings.');
  if (err instanceof PermissionDeniedError) return new AiError('auth', `This API key is not allowed to make this request: ${apiErrorDetail(err)}`);
  if (err instanceof NotFoundError) {
    return new AiError('not_configured', `Model "${model}" is not available for this API key. Check the model name in Settings.`);
  }
  if (err instanceof RateLimitError) return new AiError('rate_limit', 'Anthropic rate limit reached. Wait a moment and try again.');
  if (err instanceof BadRequestError) return new AiError('unknown', `Anthropic rejected the request: ${apiErrorDetail(err)}`);
  if (err instanceof InternalServerError) return new AiError('network', 'Anthropic is temporarily unavailable or overloaded. Try again shortly.');
  if (err instanceof APIConnectionTimeoutError) return new AiError('timeout', 'Anthropic did not answer in time. Try again.');
  if (err instanceof APIConnectionError) return new AiError('network', 'Cannot reach the Anthropic API. Check the internet connection.');
  if (err instanceof APIError) return new AiError('unknown', `Anthropic API error: ${apiErrorDetail(err)}`);
  return new AiError('unknown', 'Unexpected error while calling Anthropic.');
}

/**
 * Anthropic provider using the official SDK (@anthropic-ai/sdk): client.messages.parse() with
 * output_config: { format: zodOutputFormat(schema), effort }, thinking left at default (adaptive), no
 * temperature/top_p/top_k (they 400 on Haiku 5.5), no assistant prefill. Read content blocks by type.
 * Handle stop_reason 'refusal' -> AiError('refusal'), 'max_tokens' -> AiError('invalid_output').
 * Map SDK errors: AuthenticationError->auth, RateLimitError->rate_limit, APIConnectionError->network,
 * APIConnectionTimeoutError->timeout. maxRetries 1. Cost via priceFor(model).
 * The static system prompt carries cache_control so repeated calls of one purpose hit the prompt cache.
 * `client` is a test seam (e.g. a client with a fake fetch).
 */
export function createAnthropicProvider(opts: { apiKey: string; model: string; client?: Anthropic }): LlmProvider {
  // authToken: null stops the SDK from also sending ANTHROPIC_AUTH_TOKEN from the environment (that 401s).
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, authToken: null, maxRetries: 1 });
  const model = opts.model;
  return {
    id: 'anthropic',
    model,
    isCloud: true,

    async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<LlmResult<z.infer<S>>> {
      const started = performance.now();
      let response;
      try {
        response = await client.messages.parse(
          {
            model,
            max_tokens: Math.max(req.maxTokens, MIN_MAX_TOKENS),
            system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: req.user }],
            output_config: { format: safeOutputFormat(req.schema), effort: req.effort },
          },
          { timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        );
      } catch (err) {
        throw toAnthropicError(err, model);
      }
      const usage = anthropicUsage(model, response.usage, performance.now() - started);
      if (response.stop_reason === 'refusal') {
        throw new AiError('refusal', 'Claude declined to answer this message. Use fast mode or write the reply manually.', usage);
      }
      if (response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded') {
        throw new AiError('invalid_output', 'The AI answer was cut off before it was complete. Try again.', usage);
      }
      const parsed = response.parsed_output;
      if (!parsed?.ok) {
        throw new AiError('invalid_output', 'The AI returned an answer in an unexpected format. Try again or use fast mode.', usage);
      }
      return { data: parsed.data, usage };
    },

    async test() {
      try {
        await client.models.retrieve(model, null, { timeout: TEST_TIMEOUT_MS });
        return { ok: true, detail: `Connected to Anthropic. Model ${model} is available.` };
      } catch (err) {
        return { ok: false, detail: toAnthropicError(err, model).message };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

interface OllamaChatResponse {
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models?: { name?: string; model?: string }[];
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const JSON_HEADERS = { 'content-type': 'application/json' };
const TRAILING_SLASHES_RE = /\/+$/;
const LEADING_THINK_RE = /^\s*<think>[\s\S]*?<\/think>\s*/i;

const ollamaFormats = new WeakMap<z.ZodType, Record<string, unknown>>();

/** JSON schema for Ollama's `format` (structured outputs), cached per schema. */
function ollamaFormat(schema: z.ZodType): Record<string, unknown> {
  let format = ollamaFormats.get(schema);
  if (!format) {
    format = { ...z.toJSONSchema(schema) } as Record<string, unknown>;
    delete format.$schema;
    ollamaFormats.set(schema, format);
  }
  return format;
}

function parseModelJson<S extends z.ZodType>(content: string, schema: S): SafeParsed<z.infer<S>> {
  let json: unknown;
  try {
    // Thinking models may prepend their reasoning when the server does not separate it.
    json = JSON.parse(content.replace(LEADING_THINK_RE, ''));
  } catch {
    return { ok: false };
  }
  const result = schema.safeParse(json);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}

const LOOPBACK_IPV4_RE = /^127(?:\.\d{1,3}){3}$/;
const LOCAL_HOSTNAMES = new Set(['localhost', '[::1]', '0.0.0.0']);

/**
 * True when the URL points at this computer (loopback). Anything else (LAN or internet host) means requests leave
 * the computer. An unparsable URL cannot send anything, so it counts as local.
 */
export function isLoopbackUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || LOOPBACK_IPV4_RE.test(hostname);
}

/** "llama3.2" and "llama3.2:latest" name the same model. */
function normalizeOllamaModel(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.includes(':') ? lower : `${lower}:latest`;
}

async function ollamaHttpError(res: Response, model: string): Promise<AiError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') detail = body.error.slice(0, 200);
  } catch {
    // Body is optional detail only.
  }
  if (res.status === 404) return new AiError('not_configured', `Ollama model "${model}" is not installed. Run: ollama pull ${model}`);
  return new AiError('unknown', `Ollama error (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
}

function toOllamaError(err: unknown, baseUrl: string): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Error && err.name === 'TimeoutError') return new AiError('timeout', 'The local model did not answer in time.');
  if (err instanceof SyntaxError) return new AiError('invalid_output', 'Ollama returned a response that is not valid JSON.');
  return new AiError('network', `Cannot reach Ollama at ${baseUrl}. Is Ollama running?`);
}

/** One HTTP round trip to Ollama; the timeout covers reading the body too. */
async function ollamaJson<T>(doFetch: FetchLike, baseUrl: string, path: string, init: RequestInit, timeoutMs: number, model: string): Promise<T> {
  try {
    const res = await doFetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw await ollamaHttpError(res, model);
    return (await res.json()) as T;
  } catch (err) {
    throw toOllamaError(err, baseUrl);
  }
}

/**
 * Ollama provider: POST {url}/api/chat with { model, stream: false, format: <JSON schema from z.toJSONSchema>,
 * messages: [{role:'system'},{role:'user'}], options: { temperature: 0.2 } }. Validate with schema.safeParse.
 * Usage from prompt_eval_count / eval_count; costUsd = 0. test() calls GET {url}/api/tags and checks the model exists.
 * isCloud is false only for a loopback URL: an Ollama server on another machine receives the customer's text, so
 * pseudonymization and strict local mode must treat it like a cloud provider.
 * `fetch` is a test seam (defaults to the global fetch at call time).
 */
export function createOllamaProvider(opts: { url: string; model: string; fetch?: FetchLike }): LlmProvider {
  const baseUrl = opts.url.trim().replace(TRAILING_SLASHES_RE, '');
  const model = opts.model;
  const doFetch: FetchLike = (input, init) => (opts.fetch ?? globalThis.fetch)(input, init);
  return {
    id: 'ollama',
    model,
    isCloud: !isLoopbackUrl(baseUrl),

    async generateJson<S extends z.ZodType>(req: JsonRequest<S>): Promise<LlmResult<z.infer<S>>> {
      const started = performance.now();
      const body = {
        model,
        stream: false,
        format: ollamaFormat(req.schema),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        options: { temperature: 0.2, num_predict: req.maxTokens },
      };
      const init: RequestInit = { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) };
      const res = await ollamaJson<OllamaChatResponse>(doFetch, baseUrl, '/api/chat', init, req.timeoutMs ?? DEFAULT_TIMEOUT_MS, model);
      const usage: LlmUsage = {
        provider: 'ollama',
        model,
        inputTokens: res.prompt_eval_count ?? 0,
        outputTokens: res.eval_count ?? 0,
        costUsd: 0,
        latencyMs: Math.round(performance.now() - started),
      };
      if (res.done_reason === 'length') {
        throw new AiError('invalid_output', 'The local model stopped before finishing the answer. Try again.', usage);
      }
      const parsed = parseModelJson(res.message?.content ?? '', req.schema);
      if (!parsed.ok) {
        throw new AiError('invalid_output', 'The local model returned an answer in an unexpected format. Try again or use fast mode.', usage);
      }
      return { data: parsed.data, usage };
    },

    async test() {
      try {
        const tags = await ollamaJson<OllamaTagsResponse>(doFetch, baseUrl, '/api/tags', { method: 'GET' }, TEST_TIMEOUT_MS, model);
        const wanted = normalizeOllamaModel(model);
        const installed = (tags.models ?? []).some((m) => [m.name, m.model].some((n) => n && normalizeOllamaModel(n) === wanted));
        return installed
          ? { ok: true, detail: `Ollama is running and model ${model} is installed.` }
          : { ok: false, detail: `Ollama is running, but model "${model}" is not installed. Run: ollama pull ${model}` };
      } catch (err) {
        return { ok: false, detail: toOllamaError(err, baseUrl).message };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

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

/** Prompt-cache price multipliers relative to the base input rate (5-minute cache writes, cache reads). */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Cost of one Anthropic call, pricing cache writes and cache reads at their own rates. */
export function anthropicCostUsd(model: string, t: { input: number; cacheWrite: number; cacheRead: number; output: number }): number {
  const billedInput = t.input + t.cacheWrite * CACHE_WRITE_MULTIPLIER + t.cacheRead * CACHE_READ_MULTIPLIER;
  return costUsd(model, billedInput, t.output);
}
