/**
 * Auto-save for the Settings page.
 *
 *   const saver = useSettingsSaver();
 *   saver.update({ ai: { provider: 'anthropic' } });
 *
 * Every change is applied to the global store immediately (optimistic, so e.g. the theme switches instantly) and
 * collected into one partial patch that is sent with PUT /api/settings after 400 ms of inactivity. Requests are
 * serialized; changes made while a request is in flight are kept and sent afterwards. On failure the failed patch
 * is rolled back to the last settings confirmed by the server and the error is shown as a toast.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, DeepPartial } from '../../../shared/types';
import { api } from '../../api';
import { actions, getState } from '../../store';
import { toast } from '../../ui';
import { deepMerge, errorMessage } from './settingsUtils';

export type SettingsPatch = DeepPartial<AppSettings>;
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

const DEBOUNCE_MS = 400;
const SAVED_VISIBLE_MS = 2500;

export interface SettingsSaver {
  state: SaveState;
  /** Apply a partial change locally and schedule a save. */
  update: (patch: SettingsPatch) => void;
  /** Send pending changes now (e.g. Ctrl+S or when leaving the page). */
  flush: () => void;
  /** Settings returned by another endpoint (e.g. API key save); keeps unsaved local changes on top. */
  applyServerSettings: (settings: AppSettings) => void;
}

export function useSettingsSaver(): SettingsSaver {
  const [state, setSaveState] = useState<SaveState>('idle');
  const pending = useRef<SettingsPatch | null>(null);
  const confirmed = useRef<AppSettings | null>(getState().settings);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const mounted = useRef(true);

  const setSafeState = useCallback((s: SaveState) => {
    if (!mounted.current) return;
    if (savedTimer.current) {
      clearTimeout(savedTimer.current);
      savedTimer.current = null;
    }
    setSaveState(s);
    if (s === 'saved') {
      savedTimer.current = setTimeout(() => {
        if (mounted.current) setSaveState('idle');
      }, SAVED_VISIBLE_MS);
    }
  }, []);

  // `flush` and `schedule` reference each other; keep the latest flush in a ref.
  const flushRef = useRef<() => Promise<void>>(async () => {});

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flushRef.current();
    }, DEBOUNCE_MS);
  }, []);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inflight.current || !pending.current) return;
    const patch = pending.current;
    pending.current = null;
    inflight.current = true;
    setSafeState('saving');
    try {
      const result = await api('PUT /api/settings', { body: patch });
      confirmed.current = result;
      actions.setSettings(pending.current ? deepMerge(result, pending.current) : result);
      if (!pending.current) setSafeState('saved');
      actions.refreshHealth().catch((err: unknown) => toast(errorMessage(err), 'danger'));
    } catch (err) {
      toast(`Settings not saved: ${errorMessage(err)}`, 'danger');
      const base = confirmed.current ?? getState().settings;
      if (base) actions.setSettings(pending.current ? deepMerge(base, pending.current) : base);
      setSafeState('error');
    } finally {
      inflight.current = false;
      // Changes made while the request was in flight: save them too.
      if (pending.current && !timer.current) schedule();
    }
  }, [schedule, setSafeState]);
  flushRef.current = flush;

  const update = useCallback(
    (patch: SettingsPatch) => {
      const current = getState().settings;
      if (!current) return;
      if (!confirmed.current) confirmed.current = current;
      pending.current = pending.current ? deepMerge(pending.current, patch) : patch;
      actions.setSettings(deepMerge(current, patch));
      setSafeState('pending');
      schedule();
    },
    [schedule, setSafeState],
  );

  const applyServerSettings = useCallback((settings: AppSettings) => {
    confirmed.current = settings;
    actions.setSettings(pending.current ? deepMerge(settings, pending.current) : settings);
  }, []);

  // Save whatever is pending when the page unmounts (navigating away must not lose a change).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (savedTimer.current) clearTimeout(savedTimer.current);
      if (pending.current) void flushRef.current();
    };
  }, []);

  const flushNow = useCallback(() => void flush(), [flush]);

  return { state, update, flush: flushNow, applyServerSettings };
}
