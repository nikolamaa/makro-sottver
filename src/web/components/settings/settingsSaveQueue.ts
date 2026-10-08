/**
 * Framework-free core of the Settings auto-save (wrapped by useSettingsSaver).
 *
 * - update(): applies a change locally right away (optimistic) and merges it into one pending partial patch,
 *   which is sent after `debounceMs` of inactivity.
 * - Requests are serialized. Changes made while a request is in flight are kept and sent afterwards.
 * - On failure the store falls back to the last settings confirmed by the server, with any newer pending changes
 *   kept on top.
 * - whenIdle(): sends pending changes immediately and resolves once nothing is pending or in flight. Use it before
 *   an action that reads the saved settings on the server (e.g. "Test connection" right after editing the URL).
 */
import type { AppSettings, DeepPartial } from '../../../shared/types';
import { deepMerge } from './settingsUtils';

export type SettingsPatch = DeepPartial<AppSettings>;
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface SaveQueueDeps {
  /** Current settings in the store (null before they are loaded). */
  getSettings: () => AppSettings | null;
  /** Put settings into the store. */
  applyLocal: (settings: AppSettings) => void;
  /** PUT the partial patch; resolves with the full settings the server saved. */
  send: (patch: SettingsPatch) => Promise<AppSettings>;
  onSaved?: (settings: AppSettings) => void;
  onError?: (err: unknown) => void;
  onState?: (state: SaveState) => void;
  debounceMs: number;
}

export class SettingsSaveQueue {
  private pending: SettingsPatch | null = null;
  private confirmed: AppSettings | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  /** Send right after the current request instead of waiting for the debounce again. */
  private flushAfterInflight = false;
  private waiters: (() => void)[] = [];

  constructor(private readonly deps: SaveQueueDeps) {}

  /** True while a change is waiting to be sent or a request is in flight. */
  get busy(): boolean {
    return this.inflight || this.pending !== null;
  }

  update(patch: SettingsPatch): void {
    const current = this.deps.getSettings();
    if (!current) return;
    if (!this.confirmed) this.confirmed = current;
    this.pending = this.pending ? deepMerge(this.pending, patch) : patch;
    this.deps.applyLocal(deepMerge(current, patch));
    this.deps.onState?.('pending');
    this.schedule();
  }

  /** Settings returned by another endpoint (e.g. API key save); unsaved local changes stay on top. */
  applyServerSettings(settings: AppSettings): void {
    this.confirmed = settings;
    this.deps.applyLocal(this.pending ? deepMerge(settings, this.pending) : settings);
  }

  /** Send pending changes now (or right after the request that is in flight). */
  flush(): void {
    this.clearTimer();
    if (this.inflight) {
      if (this.pending) this.flushAfterInflight = true;
      return;
    }
    if (this.pending) void this.send();
  }

  /** Flush, then resolve once every change has been sent (whether or not the save succeeded). */
  whenIdle(): Promise<void> {
    this.flush();
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.deps.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async send(): Promise<void> {
    const patch = this.pending;
    if (!patch) return;
    this.pending = null;
    this.inflight = true;
    this.deps.onState?.('saving');
    try {
      const result = await this.deps.send(patch);
      this.confirmed = result;
      this.deps.applyLocal(this.pending ? deepMerge(result, this.pending) : result);
      if (!this.pending) this.deps.onState?.('saved');
      this.deps.onSaved?.(result);
    } catch (err) {
      this.deps.onError?.(err);
      const base = this.confirmed ?? this.deps.getSettings();
      if (base) this.deps.applyLocal(this.pending ? deepMerge(base, this.pending) : base);
      this.deps.onState?.('error');
    } finally {
      this.inflight = false;
    }

    if (this.pending) {
      // Changes made while the request was in flight.
      if (this.flushAfterInflight || this.waiters.length) {
        this.flushAfterInflight = false;
        this.flush();
      } else if (!this.timer) {
        this.schedule();
      }
      return;
    }
    this.flushAfterInflight = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
