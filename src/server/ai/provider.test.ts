import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AiError,
  anthropicCostUsd,
  costUsd,
  createAnthropicProvider,
  createOllamaProvider,
  isLoopbackUrl,
  priceFor,
  type JsonRequest,
} from './provider.js';

const Schema = z.object({ answer: z.string(), score: z.number().min(0).max(1) });

function request(overrides: Partial<JsonRequest<typeof Schema>> = {}): JsonRequest<typeof Schema> {
  return { purpose: 'personalize', system: 'STATIC SYSTEM PROMPT', user: '<customer_message>\nhi\n</customer_message>', schema: Schema, maxTokens: 4096, effort: 'low', ...overrides };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AiError);
    return (err as AiError).code;
  }
  throw new Error('expected the promise to reject');
}

// ---------------------------------------------------------------------------
// Anthropic (real SDK client, fake fetch)
// ---------------------------------------------------------------------------

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Headers;
}

function anthropicWith(respond: (req: Captured, signal: AbortSignal | null | undefined) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const client = new Anthropic({
    apiKey: 'sk-ant-test',
    maxRetries: 0,
    fetch: async (input, init) => {
      const captured: Captured = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
        headers: new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]),
      };
      calls.push(captured);
      return respond(captured, init?.signal);
    },
  });
  return { provider: createAnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-haiku-5-5', client }), calls };
}

function message(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 },
    ...extra,
  };
}

function apiError(status: number, type: string, msg = 'boom') {
  return json({ type: 'error', error: { type, message: msg } }, status);
}

describe('createAnthropicProvider', () => {
  it('sends a Haiku 5.5-safe structured-output request', async () => {
    const { provider, calls } = anthropicWith(() => json(message(JSON.stringify({ answer: 'ok', score: 0.5 }))));
    await provider.generateJson(request({ maxTokens: 512 }));

    expect(calls).toHaveLength(1);
    const { url, body, headers } = calls[0]!;
    expect(url).toMatch(/\/v1\/messages$/);
    expect(headers.get('x-api-key')).toBe('sk-ant-test');
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 2048,
      system: [{ type: 'text', text: 'STATIC SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: '<customer_message>\nhi\n</customer_message>' }],
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    const format = (body!.output_config as { format: { schema: { properties: Record<string, unknown> } } }).format;
    expect(Object.keys(format.schema.properties)).toEqual(['answer', 'score']);
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'thinking']) expect(body).not.toHaveProperty(forbidden);
    // Messages end with a user turn (no assistant prefill).
    expect((body!.messages as unknown[]).length).toBe(1);
  });

  it('parses the text block after thinking and reports usage and cache-aware cost', async () => {
    const { provider } = anthropicWith(() => json(message(JSON.stringify({ answer: 'Hello', score: 0.9 }))));
    const result = await provider.generateJson(request());
    expect(result.data).toEqual({ answer: 'Hello', score: 0.9 });
    expect(result.usage).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 1200, outputTokens: 100 });
    expect(result.usage.costUsd).toBeCloseTo(((200 + 1000 * 0.1) * 0.1 + 100 * 0.5) / 1_000_000, 12);
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('maps a refusal to AiError("refusal") and keeps the billed usage', async () => {
    const { provider } = anthropicWith(() => json(message('', { stop_reason: 'refusal', stop_details: { category: 'general_harms', explanation: null } })));
    const err = await provider.generateJson(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe('refusal');
    expect((err as AiError).usage?.outputTokens).toBe(100);
  });

  it('maps a cut-off answer and schema violations to invalid_output', async () => {
    const cut = anthropicWith(() => json(message('{"answer": "par', { stop_reason: 'max_tokens' })));
    expect(await codeOf(cut.provider.generateJson(request()))).toBe('invalid_output');
    const bad = anthropicWith(() => json(message(JSON.stringify({ answer: 'x', score: 7 }))));
    expect(await codeOf(bad.provider.generateJson(request()))).toBe('invalid_output');
    const notJson = anthropicWith(() => json(message('Sure! Here you go')));
    expect(await codeOf(notJson.provider.generateJson(request()))).toBe('invalid_output');
  });

  it.each([
    [401, 'authentication_error', 'auth'],
    [403, 'permission_error', 'auth'],
    [404, 'not_found_error', 'not_configured'],
    [429, 'rate_limit_error', 'rate_limit'],
    [400, 'invalid_request_error', 'unknown'],
    [529, 'overloaded_error', 'network'],
    [500, 'api_error', 'network'],
  ])('maps HTTP %i (%s) to %s', async (status, type, code) => {
    const { provider } = anthropicWith(() => apiError(status, type));
    expect(await codeOf(provider.generateJson(request()))).toBe(code);
  });

  it('includes the API detail for bad requests', async () => {
    const { provider } = anthropicWith(() => apiError(400, 'invalid_request_error', 'max_tokens: too large'));
    await expect(provider.generateJson(request())).rejects.toThrow(/max_tokens: too large/);
  });

  it('maps connection failures to network and timeouts to timeout', async () => {
    const down = anthropicWith(() => {
      throw new TypeError('fetch failed');
    });
    expect(await codeOf(down.provider.generateJson(request()))).toBe('network');

    const slow = anthropicWith(
      (_req, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    expect(await codeOf(slow.provider.generateJson(request({ timeoutMs: 30 })))).toBe('timeout');
  });

  it('cancels the HTTP request when the caller aborts (AiError "cancelled", no retry)', async () => {
    let aborted = false;
    const hanging = anthropicWith(
      (_req, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const ctrl = new AbortController();
    const pending = codeOf(hanging.provider.generateJson(request({ signal: ctrl.signal })));
    await vi.waitFor(() => expect(hanging.calls).toHaveLength(1));
    ctrl.abort();
    expect(await pending).toBe('cancelled');
    expect(aborted).toBe(true);
    expect(hanging.calls).toHaveLength(1);

    // The timeout still applies when a cancel signal is given.
    const slow = anthropicWith(
      (_req, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    expect(await codeOf(slow.provider.generateJson(request({ timeoutMs: 30, signal: new AbortController().signal })))).toBe('timeout');
  });

  it('test() checks the key and model with a free models.retrieve call', async () => {
    const ok = anthropicWith(() => json({ type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-01-01T00:00:00Z' }));
    await expect(ok.provider.test()).resolves.toMatchObject({ ok: true });
    expect(ok.calls[0]).toMatchObject({ method: 'GET' });
    expect(ok.calls[0]!.url).toMatch(/\/v1\/models\/claude-haiku-5-5$/);

    const denied = anthropicWith(() => apiError(401, 'authentication_error'));
    const result = await denied.provider.test();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/API key/);
  });

  it('is marked as a cloud provider', () => {
    const { provider } = anthropicWith(() => json({}));
    expect(provider).toMatchObject({ id: 'anthropic', model: 'claude-haiku-5-5', isCloud: true });
  });
});

// ---------------------------------------------------------------------------
// Ollama (fake fetch)
// ---------------------------------------------------------------------------

function ollamaWith(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = createOllamaProvider({
    url: 'http://127.0.0.1:11434/',
    model: 'qwen3:4b',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  });
  return { provider, calls };
}

const chat = (content: string, extra: Record<string, unknown> = {}) =>
  json({ model: 'qwen3:4b', message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 321, eval_count: 54, ...extra });

describe('createOllamaProvider', () => {
  it('posts a non-streaming chat request with a JSON schema format', async () => {
    const { provider, calls } = ollamaWith(() => chat(JSON.stringify({ answer: 'hi', score: 0.2 })));
    const result = await provider.generateJson(request());

    expect(result.data).toEqual({ answer: 'hi', score: 0.2 });
    expect(result.usage).toMatchObject({ provider: 'ollama', model: 'qwen3:4b', inputTokens: 321, outputTokens: 54, costUsd: 0 });
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen3:4b',
      stream: false,
      messages: [
        { role: 'system', content: 'STATIC SYSTEM PROMPT' },
        { role: 'user', content: '<customer_message>\nhi\n</customer_message>' },
      ],
      options: { temperature: 0.2, num_predict: 4096 },
      format: { type: 'object', required: ['answer', 'score'] },
    });
    expect(body.format).not.toHaveProperty('$schema');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts JSON preceded by a <think> block', async () => {
    const { provider } = ollamaWith(() => chat(`<think>\nreasoning\n</think>\n${JSON.stringify({ answer: 'a', score: 1 })}`));
    await expect(provider.generateJson(request())).resolves.toMatchObject({ data: { answer: 'a', score: 1 } });
  });

  it('rejects invalid JSON, schema mismatches and cut-off answers as invalid_output', async () => {
    expect(await codeOf(ollamaWith(() => chat('not json')).provider.generateJson(request()))).toBe('invalid_output');
    expect(await codeOf(ollamaWith(() => chat('{"answer": 1}')).provider.generateJson(request()))).toBe('invalid_output');
    const cut = ollamaWith(() => chat('{"answer": "x", "sc', { done_reason: 'length' }));
    const err = await cut.provider.generateJson(request()).catch((e: unknown) => e);
    expect((err as AiError).code).toBe('invalid_output');
    expect((err as AiError).usage).toMatchObject({ provider: 'ollama', costUsd: 0 });
    expect(await codeOf(ollamaWith(() => new Response('<html>', { status: 200 })).provider.generateJson(request()))).toBe('invalid_output');
  });

  it('maps network errors, timeouts and missing models', async () => {
    const down = ollamaWith(() => {
      throw new TypeError('fetch failed');
    });
    await expect(down.provider.generateJson(request())).rejects.toMatchObject({ code: 'network', message: expect.stringContaining('http://127.0.0.1:11434') });

    const slow = ollamaWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    expect(await codeOf(slow.provider.generateJson(request({ timeoutMs: 20 })))).toBe('timeout');

    const missing = ollamaWith(() => json({ error: "model 'qwen3:4b' not found" }, 404));
    await expect(missing.provider.generateJson(request())).rejects.toMatchObject({ code: 'not_configured', message: expect.stringContaining('ollama pull qwen3:4b') });

    const broken = ollamaWith(() => json({ error: 'out of memory' }, 500));
    await expect(broken.provider.generateJson(request())).rejects.toMatchObject({ code: 'unknown', message: expect.stringContaining('out of memory') });
  });

  it('stops the local model when the caller aborts, and keeps the timeout', async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const ctrl = new AbortController();
    const cancelled = ollamaWith(hang);
    const pending = codeOf(cancelled.provider.generateJson(request({ signal: ctrl.signal })));
    await vi.waitFor(() => expect(cancelled.calls).toHaveLength(1));
    ctrl.abort();
    expect(await pending).toBe('cancelled');
    expect(cancelled.calls[0]!.init.signal?.aborted).toBe(true);

    const slow = ollamaWith(hang);
    expect(await codeOf(slow.provider.generateJson(request({ timeoutMs: 20, signal: new AbortController().signal })))).toBe('timeout');
  });

  it('test() looks for the model in /api/tags', async () => {
    const installed = ollamaWith(() => json({ models: [{ name: 'qwen3:4b', model: 'qwen3:4b' }] }));
    await expect(installed.provider.test()).resolves.toMatchObject({ ok: true });
    expect(installed.calls[0]!.url).toBe('http://127.0.0.1:11434/api/tags');

    const other = ollamaWith(() => json({ models: [{ name: 'llama3.2:latest' }] }));
    await expect(other.provider.test()).resolves.toMatchObject({ ok: false, detail: expect.stringContaining('ollama pull qwen3:4b') });

    const latest = createOllamaProvider({ url: 'http://x', model: 'llama3.2', fetch: async () => json({ models: [{ name: 'llama3.2:latest' }] }) });
    await expect(latest.test()).resolves.toMatchObject({ ok: true });

    const down = ollamaWith(() => {
      throw new TypeError('fetch failed');
    });
    await expect(down.provider.test()).resolves.toMatchObject({ ok: false, detail: expect.stringContaining('Is Ollama running') });
  });

  it('is marked as a local provider', () => {
    expect(ollamaWith(() => json({})).provider).toMatchObject({ id: 'ollama', isCloud: false });
  });

  it('is marked as cloud when the URL points to another computer', () => {
    const remote = createOllamaProvider({ url: 'https://gpu-box.example.com/', model: 'qwen3:4b', fetch: async () => json({}) });
    expect(remote.isCloud).toBe(true);
    expect(createOllamaProvider({ url: 'http://192.168.1.20:11434', model: 'qwen3:4b' }).isCloud).toBe(true);
    expect(createOllamaProvider({ url: 'http://localhost:11434', model: 'qwen3:4b' }).isCloud).toBe(false);
  });
});

describe('isLoopbackUrl', () => {
  it.each([
    ['http://127.0.0.1:11434', true],
    ['http://127.1.2.3:11434', true],
    ['http://localhost:11434', true],
    ['http://LOCALHOST', true],
    ['http://ollama.localhost:11434', true],
    ['http://[::1]:11434', true],
    ['http://0.0.0.0:11434', true],
    ['not a url', true],
    ['http://192.168.1.20:11434', false],
    ['http://10.0.0.5', false],
    ['https://ollama.example.com', false],
    ['http://127.0.0.1.evil.com', false],
    ['http://localhost.evil.com', false],
  ])('%s -> %s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe('pricing', () => {
  it('uses the model table with a Haiku fallback', () => {
    expect(priceFor('claude-haiku-5-5')).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
    expect(priceFor('unknown-model')).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
    expect(costUsd('claude-haiku-5-5', 1_000_000, 1_000_000)).toBeCloseTo(0.6, 10);
  });

  it('prices cache writes at 1.25x and cache reads at 0.1x the input rate', () => {
    const cost = anthropicCostUsd('claude-sonnet-5-5', { input: 1000, cacheWrite: 2000, cacheRead: 10_000, output: 500 });
    expect(cost).toBeCloseTo(((1000 + 2500 + 1000) * 2 + 500 * 10) / 1_000_000, 12);
  });
});
