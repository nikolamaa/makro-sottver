import { describe, expect, it } from 'vitest';
import type { EmbedderStatus } from '../../../shared/types';
import { deepMerge, embeddingSwitchSettled, errorMessage, formatUsd } from './settingsUtils';

const status = (provider: EmbedderStatus['provider'], state: EmbedderStatus['state'] = 'ready', model = 'm'): EmbedderStatus => ({
  provider,
  model,
  state,
  detail: '',
});

describe('embeddingSwitchSettled', () => {
  it('is not settled while the server still reports the previous engine as ready', () => {
    // Switching to the neural model: health keeps saying "builtin, ready" until the download finished.
    expect(embeddingSwitchSettled({ provider: 'transformers', ollamaModel: 'nomic-embed-text' }, status('builtin'))).toBe(false);
    expect(embeddingSwitchSettled({ provider: 'transformers', ollamaModel: 'nomic-embed-text' }, status('transformers', 'loading'))).toBe(false);
    expect(embeddingSwitchSettled({ provider: 'transformers', ollamaModel: 'nomic-embed-text' }, status('transformers'))).toBe(true);
  });

  it('checks the Ollama model name', () => {
    const sel = { provider: 'ollama' as const, ollamaModel: 'mxbai-embed-large' };
    expect(embeddingSwitchSettled(sel, status('ollama', 'ready', 'nomic-embed-text'))).toBe(false);
    expect(embeddingSwitchSettled(sel, status('ollama', 'ready', 'mxbai-embed-large'))).toBe(true);
  });

  it('handles builtin, auto and unknown status', () => {
    expect(embeddingSwitchSettled({ provider: 'builtin', ollamaModel: 'x' }, status('builtin'))).toBe(true);
    expect(embeddingSwitchSettled({ provider: 'builtin', ollamaModel: 'x' }, status('transformers'))).toBe(false);
    expect(embeddingSwitchSettled({ provider: 'auto', ollamaModel: 'x' }, status('transformers'))).toBe(true);
    expect(embeddingSwitchSettled({ provider: 'auto', ollamaModel: 'x' }, null)).toBe(false);
  });
});

describe('settingsUtils', () => {
  it('deepMerge replaces leaves and arrays without mutating the base', () => {
    const base = { a: { b: 1, c: [1, 2] }, d: 'x' };
    const out = deepMerge(base, { a: { c: [3] } });
    expect(out).toEqual({ a: { b: 1, c: [3] }, d: 'x' });
    expect(base.a.c).toEqual([1, 2]);
  });

  it('errorMessage unwraps JSON error bodies from downloads', () => {
    expect(errorMessage(new Error('{"error":"format must be json or backup"}'))).toBe('format must be json or backup');
    expect(errorMessage(new Error('  '))).toBe('Something went wrong');
    expect(errorMessage('plain')).toBe('plain');
  });

  it('formatUsd uses 4 decimals by default', () => {
    expect(formatUsd(0.0004)).toBe('$0.0004');
    expect(formatUsd(Number.NaN, 2)).toBe('$0.00');
  });
});
