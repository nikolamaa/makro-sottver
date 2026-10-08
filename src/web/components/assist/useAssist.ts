/**
 * Assist page controller: wires the pure reducer (assistState.ts) to the server and the browser.
 *
 *   message -> debounce 120 ms -> POST /api/recommend (previous request aborted) -> auto-select #1
 *   shown result -> (AI ready + double-check on) -> POST /api/rerank -> AI scores in place, never reorders
 *   selection/variables -> POST /api/personalize (fast) -> editor -> optional AI polish
 *   copy -> placeholder guard -> clipboard -> usage event (+ background macro refresh)
 *
 * The page state survives switching to the Library and back (module-level snapshot).
 */
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type Dispatch, type RefObject } from 'react';
import { editRatio } from '../../../shared/template';
import type { Id, PersonalizeRequest, RecommendResponse } from '../../../shared/types';
import { api } from '../../api';
import { comboLabel } from '../../hotkeys';
import { actions as storeActions, getState, setState, useStore } from '../../store';
import { toast } from '../../ui';
import {
  assistReducer,
  buildNewMacroDraft,
  INITIAL_ASSIST_STATE,
  NEW_MACRO_DRAFT_KEY,
  personalizeKey,
  type AssistAction,
  type AssistState,
} from './assistState';
import {
  COPY_CONFIRM_WINDOW_MS,
  copyText,
  decideCopy,
  isEditableTarget,
  MAX_MESSAGE_CHARS,
  readClipboardText,
  shouldAdoptClipboard,
} from './clipboard';
import { plural } from './format';
import { useDebouncedValue } from './hooks';
import { IDLE_RERANK } from './rerank';
import { errorText, isAbortError, recordCopy, sendEvent } from './requests';
import { MAX_COMBINE, selectOnly, stepSelection, toggleCombine } from './selection';
import { selectNextPlaceholder } from './textSelection';
import { requestVariables } from './variables';

const RECOMMEND_DEBOUNCE_MS = 120;
/**
 * Pause after a local result before the AI double-check is requested, so typing a message by hand does not send
 * one AI request per pause (each result arriving restarts the wait).
 */
export const RERANK_DELAY_MS = 600;
const VARIABLES_DEBOUNCE_MS = 200;
const NO_VARIABLES_KEY = '{}';

/** Page snapshot kept while the agent visits other pages (in-memory only, never persisted). */
let savedState: AssistState | null = null;

function restoreState(): AssistState {
  if (!savedState) return INITIAL_ASSIST_STATE;
  // Requests do not survive leaving the page: a double-check that was running is started again.
  const rerank = savedState.rerank.status === 'running' ? IDLE_RERANK : savedState.rerank;
  return { ...savedState, busy: { ai: false, draft: false }, rerank };
}

function recIdsOf(result: RecommendResponse | null): Id[] {
  return result?.recommendations.map((r) => r.macroId) ?? [];
}

/** Usage events for a fresh recommendation result (ids and scores only). */
function reportResult(result: RecommendResponse): void {
  const intents = result.analysis.intents.map((i) => i.intent);
  const top = result.recommendations[0];
  if (top) {
    void sendEvent({ type: 'recommendation_shown', macroIds: recIdsOf(result), confidence: top.confidence, intents });
  }
  if (result.noGoodMatch) void sendEvent({ type: 'no_match', intents, ...(top ? { confidence: top.confidence } : {}) });
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Refs and dispatch the Assist actions operate on. */
export interface ActionContext {
  dispatch: Dispatch<AssistAction>;
  state: RefObject<AssistState>;
  messageEl: RefObject<HTMLTextAreaElement | null>;
  editorEl: RefObject<HTMLTextAreaElement | null>;
  aiRequest: { current: AbortController | null };
  copyArmedUntil: { current: number };
}

export type AssistActions = ReturnType<typeof createAssistActions>;

/** Stable action set; reads the latest state through refs so callbacks never change identity. */
export function createAssistActions(ctx: ActionContext) {
  const { dispatch } = ctx;
  const current = () => ctx.state.current;

  function stopAi(): void {
    if (!ctx.aiRequest.current) return;
    ctx.aiRequest.current.abort();
    ctx.aiRequest.current = null;
    dispatch({ type: 'aiStopped' });
  }

  function runAi(request: PersonalizeRequest, key: string): void {
    stopAi();
    const ctrl = new AbortController();
    ctx.aiRequest.current = ctrl;
    dispatch({ type: 'aiStarted' });
    api('POST /api/personalize', { body: { ...request, mode: 'ai' }, signal: ctrl.signal })
      .then((res) => dispatch({ type: 'aiReady', key, res }))
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        dispatch({ type: 'aiStopped' });
        toast(`AI polish failed: ${errorText(err)}. Keeping the fast version.`, 'danger', 4500);
      })
      .finally(() => {
        if (ctx.aiRequest.current === ctrl) ctx.aiRequest.current = null;
      });
  }

  function applySelection(ids: Id[] | null, rank: number): void {
    if (!ids) return;
    dispatch({ type: 'select', ids });
    void sendEvent({ type: 'recommendation_selected', macroIds: ids, ...(rank >= 0 ? { rank } : {}) });
  }

  function focusMessage(): void {
    ctx.messageEl.current?.focus();
  }

  /** Use any macro for the current message (personalized like a recommendation), even if it was not recommended. */
  function pickMacro(id: Id): void {
    const s = current();
    applySelection(selectOnly(s.selectedIds, [id], 0), recIdsOf(s.result).indexOf(id));
  }

  /** Start a new conversation with `text` as the customer message. */
  function loadMessage(text: string): void {
    stopAi();
    ctx.copyArmedUntil.current = 0;
    dispatch({ type: 'message', message: text, fresh: true });
    focusMessage();
  }

  return {
    stopAi,
    runAi,
    loadMessage,
    focusMessage,
    setMessage(text: string): void {
      dispatch({ type: 'message', message: text, fresh: false });
    },
    setCustomerName(value: string): void {
      dispatch({ type: 'customerName', value });
    },
    setOverride(name: string, value: string): void {
      dispatch({ type: 'override', name, value });
    },
    select(index: number): void {
      const s = current();
      applySelection(selectOnly(s.selectedIds, recIdsOf(s.result), index), index);
    },
    toggleCombine(index: number): void {
      const s = current();
      const next = toggleCombine(s.selectedIds, recIdsOf(s.result), index);
      if (next === 'limit') toast(`You can combine up to ${MAX_COMBINE} macros`, 'warning');
      else applySelection(next, index);
    },
    step(delta: 1 | -1): void {
      const s = current();
      const recIds = recIdsOf(s.result);
      const next = stepSelection(s.selectedIds, recIds, delta);
      applySelection(next, next?.[0] ? recIds.indexOf(next[0]) : -1);
    },
    /** Use any macro (from quick search) for the current message, even if it was not recommended. */
    pick: pickMacro,
    /** Use the AI double-check's top pick that is not among the cards (Alt+4). */
    pickAiSuggestion(): void {
      const { rerank, resultFor } = current();
      if (rerank.suggestion && rerank.message === resultFor) pickMacro(rerank.suggestion.macroId);
    },
    edit(text: string): void {
      dispatch({ type: 'edit', text });
    },
    applyPendingAi(): void {
      dispatch({ type: 'applyPendingAi' });
    },
    polish(): void {
      const ai = getState().health?.ai;
      if (!ai?.ready) {
        toast(ai?.detail || 'AI is off - choose a provider in Settings', 'warning');
        return;
      }
      const { reply, busy, selectedIds } = current();
      if (!selectedIds.length || !reply.request) {
        toast('Select a macro first', 'info');
        return;
      }
      if (!busy.ai) runAi(reply.request, reply.key);
    },
    async copy(): Promise<void> {
      const s = current();
      const decision = decideCopy(s.reply.text, ctx.copyArmedUntil.current, Date.now());
      if (decision.action === 'empty') {
        toast('Nothing to copy yet - pick a macro first', 'warning');
        return;
      }
      if (decision.action === 'confirm') {
        ctx.copyArmedUntil.current = decision.armedUntil;
        toast(`${plural(decision.placeholders, 'placeholder')} left - press again to copy anyway`, 'warning', COPY_CONFIRM_WINDOW_MS);
        return;
      }
      ctx.copyArmedUntil.current = 0;
      if (!(await copyText(s.reply.text))) {
        toast('Copy failed - select the text and copy it manually', 'danger');
        return;
      }
      toast('Copied', 'success', 1500);
      const rank = recIdsOf(s.result).indexOf(s.selectedIds[0] ?? '');
      const confidence = s.result?.recommendations[rank]?.confidence;
      recordCopy({
        macroIds: s.selectedIds,
        editRatio: roundRatio(editRatio(s.reply.generated, s.reply.text)),
        mode: s.reply.meta?.mode ?? 'fast',
        ...(rank >= 0 && confidence !== undefined ? { rank, confidence } : {}),
      });
    },
    async draft(): Promise<void> {
      const s = current();
      if (!s.message.trim() || s.busy.draft) return;
      stopAi();
      dispatch({ type: 'draftStarted' });
      try {
        const res = await api('POST /api/draft', {
          body: { message: s.message, variables: requestVariables(s.customerName, s.overrides) },
        });
        dispatch({ type: 'drafted', message: s.message, res });
        ctx.editorEl.current?.focus();
      } catch (err) {
        dispatch({ type: 'draftFailed' });
        toast(`Could not draft a reply: ${errorText(err)}`, 'danger');
      }
    },
    /** Hand the current reply to the Library as a new-macro draft. */
    createMacro(): void {
      try {
        sessionStorage.setItem(NEW_MACRO_DRAFT_KEY, JSON.stringify(buildNewMacroDraft(current())));
      } catch {
        toast('Could not pass the draft to the Library', 'warning');
      }
      storeActions.navigate('library');
    },
    editMacro(): void {
      const id = current().selectedIds[0];
      if (id) storeActions.openInLibrary(id);
    },
    clear(): void {
      stopAi();
      ctx.copyArmedUntil.current = 0;
      dispatch({ type: 'clear' });
      focusMessage();
    },
    async readClipboard(): Promise<void> {
      const clip = await readClipboardText();
      if (clip === null) toast(`Clipboard access is blocked - press ${comboLabel('mod+v')} on the page instead`, 'warning', 4000);
      else if (!clip.trim()) toast('The clipboard is empty', 'info');
      else loadMessage(clip);
    },
    /** Focus the reply editor and select the next placeholder, if any. */
    focusEditor(): void {
      const el = ctx.editorEl.current;
      if (el && !selectNextPlaceholder(el)) el.focus();
    },
  };
}

/** Debounced recommendation for the current message; stale requests are aborted. */
function useRecommendation(state: AssistState, dispatch: Dispatch<AssistAction>, stateRef: RefObject<AssistState>): void {
  const { message, resultFor } = state;
  useEffect(() => {
    if (!message.trim() || message === resultFor) return;
    if (message.length > MAX_MESSAGE_CHARS) {
      dispatch({ type: 'recommendFailed', message, error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters)` });
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api('POST /api/recommend', { body: { message }, signal: ctrl.signal })
        .then((result) => {
          if (stateRef.current.message !== message) return;
          dispatch({ type: 'recommended', message, result });
          reportResult(result);
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) return;
          dispatch({ type: 'recommendFailed', message, error: errorText(err) });
          toast(`Recommendation failed: ${errorText(err)}`, 'danger');
        });
    }, RECOMMEND_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [message, resultFor, dispatch, stateRef]);
}

/** True when the shown result should get an AI double-check (once per result; `enabled` = AI ready + setting on). */
export function shouldRerank(state: Pick<AssistState, 'message' | 'result' | 'resultFor' | 'rerank'>, enabled: boolean): boolean {
  const { message, result, resultFor, rerank } = state;
  if (!enabled || !result?.recommendations.length || message !== resultFor) return false;
  return !(rerank.message === resultFor && (rerank.status === 'done' || rerank.status === 'failed'));
}

/**
 * Requests the AI double-check of the result for `message` after `delayMs`. Returns the cancel function: it
 * aborts the request and reports a check that was still running as stopped. Failures are silent (no toast):
 * the "AI checking" indicator just disappears and the local result stays as it is.
 */
export function scheduleRerank(message: string, dispatch: Dispatch<AssistAction>, delayMs = RERANK_DELAY_MS): () => void {
  const ctrl = new AbortController();
  let pending = false;
  const timer = setTimeout(() => {
    pending = true;
    dispatch({ type: 'rerankStarted', message });
    api('POST /api/rerank', { body: { message }, signal: ctrl.signal })
      .then((res) => {
        pending = false;
        dispatch({ type: 'reranked', message, res });
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        pending = false;
        dispatch({ type: 'rerankFailed', message });
      });
  }, delayMs);
  return () => {
    clearTimeout(timer);
    ctrl.abort();
    if (pending) dispatch({ type: 'rerankStopped', message });
  };
}

/**
 * Optional AI double-check of the shown result while the AI is ready and the setting is on. Cancelled when the
 * message, the result or the setting changes; late answers for an older result are ignored by the reducer.
 */
function useRerank(state: AssistState, dispatch: Dispatch<AssistAction>, stateRef: RefObject<AssistState>): void {
  const enabled = useStore((s) => Boolean(s.health?.ai.ready && s.settings?.ai.rerank));
  const { message, result, resultFor } = state;
  useEffect(() => {
    // The check's own progress is read from the ref so that its updates do not restart it.
    if (!shouldRerank({ message, result, resultFor, rerank: stateRef.current.rerank }, enabled)) return;
    return scheduleRerank(resultFor, dispatch);
  }, [enabled, result, resultFor, message, dispatch, stateRef]);
}

/** Fast personalization whenever the selection, a selected macro, the message or (debounced) variables change. */
function usePersonalization(state: AssistState, dispatch: Dispatch<AssistAction>, actions: AssistActions): boolean {
  const variablesJson = useMemo(() => JSON.stringify(requestVariables(state.customerName, state.overrides)), [state.customerName, state.overrides]);
  // Debounce typing, but apply a reset (new conversation) immediately so a previous customer's values never leak.
  const variablesKey = useDebouncedValue(variablesJson, variablesJson === NO_VARIABLES_KEY ? 0 : VARIABLES_DEBOUNCE_MS);
  const { selectedIds, resultFor, reply } = state;
  const macros = useStore((s) => s.macros);
  const versions = useMemo(() => selectedIds.map((id) => macros.find((m) => m.id === id)?.version ?? 0).join(','), [selectedIds, macros]);
  const key = personalizeKey(selectedIds, versions, resultFor, variablesKey);
  const busy = selectedIds.length > 0 && key !== reply.key && key !== reply.failedKey;

  useEffect(() => {
    if (!busy) return;
    actions.stopAi();
    const ctrl = new AbortController();
    const request: PersonalizeRequest = {
      message: resultFor,
      macroIds: selectedIds,
      variables: JSON.parse(variablesKey) as Record<string, string>,
      mode: 'fast',
    };
    api('POST /api/personalize', { body: request, signal: ctrl.signal })
      .then((res) => {
        dispatch({ type: 'fastReady', key, request, res });
        const { settings, health } = getState();
        if (settings?.ai.autoPolish && health?.ai.ready) actions.runAi(request, key);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        dispatch({ type: 'fastFailed', key });
        toast(`Could not personalize the macro: ${errorText(err)}`, 'danger');
      });
    return () => ctrl.abort();
  }, [key, busy, resultFor, selectedIds, variablesKey, dispatch, actions]);

  return busy;
}

/** Ctrl+V anywhere (outside inputs) and optional clipboard auto-read on window focus. */
function useClipboardIntake(actions: AssistActions, stateRef: RefObject<AssistState>): void {
  const autoRead = useStore((s) => s.settings?.ui.autoReadClipboard ?? false);
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text.trim()) return;
      e.preventDefault();
      actions.loadMessage(text);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [actions]);

  useEffect(() => {
    if (!autoRead) return;
    const onFocus = () => {
      void readClipboardText().then((clip) => {
        const { message, reply } = stateRef.current;
        if (clip !== null && shouldAdoptClipboard(clip, { message, reply: reply.text })) actions.loadMessage(clip);
      });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [autoRead, actions, stateRef]);
}

/** A macro chosen in quick search (store.assistPickId) is applied to the current message, then cleared. */
function useQuickSearchPick(actions: AssistActions): void {
  const pickId = useStore((s) => s.assistPickId);
  useEffect(() => {
    // Re-check the store so a StrictMode effect replay does not apply the same pick twice.
    if (!pickId || getState().assistPickId !== pickId) return;
    setState({ assistPickId: null });
    actions.pick(pickId);
  }, [pickId, actions]);
}

export interface AssistController {
  state: AssistState;
  actions: AssistActions;
  /** A recommendation request for the current message is pending. */
  analyzing: boolean;
  /** A fast personalization request is pending. */
  personalizing: boolean;
  messageRef: RefObject<HTMLTextAreaElement | null>;
  editorRef: RefObject<HTMLTextAreaElement | null>;
}

/** State and actions for the Assist page. */
export function useAssist(): AssistController {
  const [state, dispatch] = useReducer(assistReducer, undefined, restoreState);
  const stateRef = useRef(state);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const aiRequest = useRef<AbortController | null>(null);
  const copyArmedUntil = useRef(0);

  useLayoutEffect(() => {
    stateRef.current = state;
    savedState = state;
  }, [state]);

  const [actions] = useState(() =>
    createAssistActions({ dispatch, state: stateRef, messageEl: messageRef, editorEl: editorRef, aiRequest, copyArmedUntil }),
  );
  useEffect(() => actions.stopAi, [actions]);

  useRecommendation(state, dispatch, stateRef);
  useRerank(state, dispatch, stateRef);
  const personalizing = usePersonalization(state, dispatch, actions);
  useClipboardIntake(actions, stateRef);
  useQuickSearchPick(actions);

  const analyzing = state.message.trim() !== '' && state.message !== state.resultFor;
  return { state, actions, analyzing, personalizing, messageRef, editorRef };
}
