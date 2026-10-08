import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/types';
import { SettingsSaveQueue, type SaveState, type SettingsPatch } from './settingsSaveQueue';
import { deepMerge } from './settingsUtils';

interface Pending {
  patch: SettingsPatch;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** A fake server + store around a queue. In `manual` mode each PUT waits until the test settles it. */
function setup(mode: 'auto' | 'manual' = 'auto') {
  const h = {
    store: structuredClone(DEFAULT_SETTINGS) as AppSettings | null,
    server: structuredClone(DEFAULT_SETTINGS),
    sent: [] as SettingsPatch[],
    states: [] as SaveState[],
    errors: [] as unknown[],
    inflight: [] as Pending[],
  };
  const queue = new SettingsSaveQueue({
    getSettings: () => h.store,
    applyLocal: (s) => {
      h.store = s;
    },
    send: (patch) => {
      h.sent.push(patch);
      const save = () => {
        h.server = deepMerge(h.server, patch);
        return structuredClone(h.server);
      };
      if (mode === 'auto') return Promise.resolve(save());
      return new Promise<AppSettings>((resolve, reject) => {
        h.inflight.push({ patch, resolve: () => resolve(save()), reject });
      });
    },
    onError: (err) => h.errors.push(err),
    onState: (s) => h.states.push(s),
    debounceMs: 400,
  });
  return { h, queue };
}

const tick = () => vi.advanceTimersByTimeAsync(0);

describe('SettingsSaveQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies changes locally at once and sends them as one merged patch after 400 ms', async () => {
    const { h, queue } = setup();
    queue.update({ ui: { theme: 'dark' } });
    queue.update({ ai: { autoPolish: true } });
    queue.update({ ai: { monthlyBudgetUsd: 12 } });
    expect(h.store?.ui.theme).toBe('dark');
    await vi.advanceTimersByTimeAsync(399);
    expect(h.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent).toEqual([{ ui: { theme: 'dark' }, ai: { autoPolish: true, monthlyBudgetUsd: 12 } }]);
    expect(h.states.at(-1)).toBe('saved');
    expect(queue.busy).toBe(false);
  });

  it('whenIdle() sends a just-edited value immediately, so "Test connection" uses the new settings', async () => {
    const { h, queue } = setup();
    queue.update({ ai: { ollamaUrl: 'http://192.168.1.20:11434' } });
    const idle = queue.whenIdle();
    // No debounce wait: the PUT goes out right away.
    expect(h.sent).toHaveLength(1);
    await idle;
    expect(h.server.ai.ollamaUrl).toBe('http://192.168.1.20:11434');
  });

  it('whenIdle() resolves at once when nothing is pending', async () => {
    const { h, queue } = setup();
    await expect(queue.whenIdle()).resolves.toBeUndefined();
    expect(h.sent).toHaveLength(0);
  });

  it('whenIdle() also waits for changes made while a request was in flight', async () => {
    const { h, queue } = setup('manual');
    queue.update({ ai: { provider: 'ollama' } });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.inflight).toHaveLength(1);
    queue.update({ ai: { ollamaModel: 'llama3.2:3b' } });

    let resolved = false;
    void queue.whenIdle().then(() => {
      resolved = true;
    });
    h.inflight[0]!.resolve();
    await tick();
    // The second change is sent right after the first request, without another debounce wait.
    expect(h.inflight).toHaveLength(2);
    expect(h.inflight[1]!.patch).toEqual({ ai: { ollamaModel: 'llama3.2:3b' } });
    expect(resolved).toBe(false);
    h.inflight[1]!.resolve();
    await tick();
    expect(resolved).toBe(true);
    expect(h.server.ai).toMatchObject({ provider: 'ollama', ollamaModel: 'llama3.2:3b' });
  });

  it('keeps changes made during a request on top of the server result and sends them afterwards', async () => {
    const { h, queue } = setup('manual');
    queue.update({ recommendation: { minConfidence: 60 } });
    await vi.advanceTimersByTimeAsync(400);
    queue.update({ recommendation: { maxResults: 2 } });
    h.inflight[0]!.resolve();
    await tick();
    // The server result (without maxResults) must not overwrite the unsent local change.
    expect(h.store?.recommendation).toEqual({ minConfidence: 60, maxResults: 2 });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.sent).toEqual([{ recommendation: { minConfidence: 60 } }, { recommendation: { maxResults: 2 } }]);
  });

  it('rolls back a failed change but keeps newer pending changes', async () => {
    const { h, queue } = setup('manual');
    queue.update({ ui: { theme: 'dark' } });
    await vi.advanceTimersByTimeAsync(400);
    queue.update({ privacy: { strictLocal: true } });
    h.inflight[0]!.reject(new Error('Server unavailable'));
    await tick();
    expect(h.errors).toHaveLength(1);
    expect(h.states).toContain('error');
    expect(h.store?.ui.theme).toBe('system');
    expect(h.store?.privacy.strictLocal).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.inflight[1]!.patch).toEqual({ privacy: { strictLocal: true } });
  });

  it('flush() during a request sends the next change right after it (Ctrl+S)', async () => {
    const { h, queue } = setup('manual');
    queue.update({ ai: { effort: 'high' } });
    await vi.advanceTimersByTimeAsync(400);
    queue.update({ ai: { effort: 'medium' } });
    queue.flush();
    h.inflight[0]!.resolve();
    await tick();
    expect(h.inflight).toHaveLength(2);
  });

  it('applyServerSettings() keeps unsaved local changes on top', () => {
    const { h, queue } = setup();
    queue.update({ ai: { monthlyBudgetUsd: 20 } });
    queue.applyServerSettings({ ...structuredClone(DEFAULT_SETTINGS), ai: { ...DEFAULT_SETTINGS.ai, anthropicKeySet: true } });
    expect(h.store?.ai.anthropicKeySet).toBe(true);
    expect(h.store?.ai.monthlyBudgetUsd).toBe(20);
  });

  it('ignores updates before settings are loaded', async () => {
    const { h, queue } = setup();
    h.store = null;
    queue.update({ ui: { theme: 'dark' } });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.sent).toHaveLength(0);
  });
});
