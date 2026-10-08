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
 * The queue logic lives in settingsSaveQueue.ts (unit tested); this hook wires it to React, the store and the API.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../../../shared/types';
import { api } from '../../api';
import { actions, getState } from '../../store';
import { toast } from '../../ui';
import { SettingsSaveQueue, type SaveState, type SettingsPatch } from './settingsSaveQueue';
import { errorMessage } from './settingsUtils';

export type { SaveState, SettingsPatch } from './settingsSaveQueue';

const DEBOUNCE_MS = 400;
const SAVED_VISIBLE_MS = 2500;

export interface SettingsSaver {
  state: SaveState;
  /** Apply a partial change locally and schedule a save. */
  update: (patch: SettingsPatch) => void;
  /** Send pending changes now (e.g. Ctrl+S or when leaving the page). */
  flush: () => void;
  /** Send pending changes now and resolve once they reached the server (or failed). */
  whenIdle: () => Promise<void>;
  /** Settings returned by another endpoint (e.g. API key save); keeps unsaved local changes on top. */
  applyServerSettings: (settings: AppSettings) => void;
}

export function useSettingsSaver(): SettingsSaver {
  const [state, setSaveState] = useState<SaveState>('idle');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const setStateRef = useRef(setSafeState);
  setStateRef.current = setSafeState;

  const queueRef = useRef<SettingsSaveQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new SettingsSaveQueue({
      getSettings: () => getState().settings,
      applyLocal: (s) => actions.setSettings(s),
      send: (patch) => api('PUT /api/settings', { body: patch }),
      onSaved: () => {
        actions.refreshHealth().catch((err: unknown) => toast(errorMessage(err), 'danger'));
      },
      onError: (err) => toast(`Settings not saved: ${errorMessage(err)}`, 'danger'),
      onState: (s) => setStateRef.current(s),
      debounceMs: DEBOUNCE_MS,
    });
  }
  const queue = queueRef.current;

  // Save whatever is pending when the page unmounts (navigating away must not lose a change).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (savedTimer.current) clearTimeout(savedTimer.current);
      queue.flush();
    };
  }, [queue]);

  const update = useCallback((patch: SettingsPatch) => queue.update(patch), [queue]);
  const flush = useCallback(() => queue.flush(), [queue]);
  const whenIdle = useCallback(() => queue.whenIdle(), [queue]);
  const applyServerSettings = useCallback((s: AppSettings) => queue.applyServerSettings(s), [queue]);

  return { state, update, flush, whenIdle, applyServerSettings };
}
