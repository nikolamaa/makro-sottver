import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthResponse } from '../../../shared/api';
import { getState, setState } from '../../store';
import { toast } from '../../ui';
import { assistReducer, INITIAL_ASSIST_STATE, NEW_MACRO_DRAFT_KEY, type AssistAction, type AssistState } from './assistState';
import { shouldAdoptClipboard } from './clipboard';
import { IDLE_RERANK } from './rerank';
import { draftFixture, personalizeFixture, recommendationFixture, rerankFixture, resultFixture } from './testFixtures';
import { createAssistActions, RERANK_DELAY_MS, scheduleRerank, shouldRerank } from './useAssist';

vi.mock('../../ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../ui')>()), toast: vi.fn() }));

const MESSAGE = 'Hi, I am Marko. Where is my withdrawal? Waiting 3 days!';

interface Call {
  route: string;
  body: Record<string, unknown> | undefined;
}

let calls: Call[];
let routes: Record<string, (body: Record<string, unknown> | undefined) => unknown>;
let clipboardWrites: string[];
let storage: Map<string, string>;

function health(ready: boolean): HealthResponse {
  return {
    ok: true,
    version: 'test',
    macroCount: 3,
    embeddings: { provider: 'builtin', model: 'concepts', state: 'ready', detail: '' },
    ai: { provider: ready ? 'anthropic' : 'none', ready, detail: ready ? '' : 'AI is off' },
  };
}

beforeEach(() => {
  calls = [];
  clipboardWrites = [];
  storage = new Map();
  routes = { 'GET /api/macros': () => [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      const route = `${init.method} ${url}`;
      calls.push({ route, body });
      return new Response(JSON.stringify(routes[route]?.(body) ?? { ok: true }), { status: 200 });
    }),
  );
  vi.stubGlobal('navigator', {
    platform: 'Linux',
    clipboard: {
      writeText: vi.fn(async (text: string) => {
        clipboardWrites.push(text);
      }),
      readText: vi.fn(async () => 'Clipboard customer message'),
    },
  });
  vi.stubGlobal('sessionStorage', { setItem: (k: string, v: string) => storage.set(k, v) });
  setState({ health: health(false), page: 'assist' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(toast).mockClear();
});

/** Actions wired to a synchronous reducer, like React would after each dispatch. */
function setup(initial: AssistState) {
  const stateRef = { current: initial };
  const focus = vi.fn();
  const dispatch = (action: AssistAction) => {
    stateRef.current = assistReducer(stateRef.current, action);
  };
  const actions = createAssistActions({
    dispatch,
    state: stateRef,
    messageEl: { current: { focus } as unknown as HTMLTextAreaElement },
    editorEl: { current: null },
    aiRequest: { current: null },
    copyArmedUntil: { current: 0 },
  });
  return { actions, stateRef, focus };
}

function withReply(text: string): AssistState {
  return [
    { type: 'message', message: MESSAGE, fresh: true },
    { type: 'recommended', message: MESSAGE, result: resultFixture() },
    { type: 'fastReady', key: 'k1', request: { message: MESSAGE, macroIds: ['a'], variables: {}, mode: 'fast' }, res: personalizeFixture(text) },
  ].reduce((s, a) => assistReducer(s, a as AssistAction), INITIAL_ASSIST_STATE);
}

function eventBodies(): Record<string, unknown>[] {
  return calls.filter((c) => c.route === 'POST /api/events').map((c) => c.body ?? {});
}

function toastTexts(): string[] {
  return vi.mocked(toast).mock.calls.map((c) => c[0]);
}

describe('copy', () => {
  it('copies, records the event without customer text, then refreshes macros', async () => {
    const { actions } = setup(withReply('Hi Marko, your withdrawal is pending.'));
    await actions.copy();
    expect(clipboardWrites).toEqual(['Hi Marko, your withdrawal is pending.']);
    expect(toastTexts()).toContain('Copied');
    await vi.waitFor(() => expect(calls.map((c) => c.route)).toContain('GET /api/macros'));
    expect(eventBodies()).toEqual([{ type: 'reply_copied', macroIds: ['a'], editRatio: 0, mode: 'fast', rank: 0, confidence: 82 }]);
    expect(JSON.stringify(eventBodies())).not.toContain('Marko');
  });

  it('remembers the copied reply so clipboard auto-read never loads it as the next customer message', async () => {
    const { actions } = setup(withReply('Hi Marko, the payout is on its way.'));
    await actions.copy();
    expect(shouldAdoptClipboard('Hi Marko, the payout is on its way.', { message: 'next customer', reply: '' })).toBe(false);
  });

  it('asks for a second press when placeholders remain', async () => {
    const { actions } = setup(withReply('ETA: [ENTER ETA TIME]'));
    await actions.copy();
    expect(clipboardWrites).toEqual([]);
    expect(toastTexts()).toContain('1 placeholder left - press again to copy anyway');
    await actions.copy();
    expect(clipboardWrites).toEqual(['ETA: [ENTER ETA TIME]']);
  });

  it('reports how much the agent edited the reply', async () => {
    const { actions } = setup(withReply('Hello there'));
    actions.edit('Hello there, friend');
    await actions.copy();
    await vi.waitFor(() => expect(eventBodies()).toHaveLength(1));
    expect(eventBodies()[0]?.editRatio).toBeGreaterThan(0);
  });

  it('does nothing for an empty reply', async () => {
    const { actions } = setup(INITIAL_ASSIST_STATE);
    await actions.copy();
    expect(clipboardWrites).toEqual([]);
    expect(eventBodies()).toEqual([]);
  });
});

describe('selection', () => {
  it('selects a card and records the rank once', async () => {
    const { actions, stateRef } = setup(withReply('text'));
    actions.select(1);
    actions.select(1);
    expect(stateRef.current.selectedIds).toEqual(['b']);
    await vi.waitFor(() => expect(eventBodies()).toEqual([{ type: 'recommendation_selected', macroIds: ['b'], rank: 1 }]));
  });

  it('combines up to three macros', () => {
    const { actions, stateRef } = setup({ ...withReply('text'), selectedIds: ['a', 'b', 'x'] });
    actions.toggleCombine(2);
    expect(toastTexts()).toContain('You can combine up to 3 macros');
    actions.toggleCombine(1);
    expect(stateRef.current.selectedIds).toEqual(['a', 'x']);
  });

  it('steps and picks macros from quick search', () => {
    const { actions, stateRef } = setup(withReply('text'));
    actions.step(1);
    expect(stateRef.current.selectedIds).toEqual(['b']);
    actions.pick('zzz');
    expect(stateRef.current.selectedIds).toEqual(['zzz']);
  });
});

describe('AI polish', () => {
  it('explains why AI is unavailable', () => {
    const { actions } = setup(withReply('text'));
    actions.polish();
    expect(toastTexts()).toContain('AI is off');
    expect(calls).toEqual([]);
  });

  it('polishes the fast reply with the same request', async () => {
    setState({ health: health(true) });
    routes['POST /api/personalize'] = () => personalizeFixture('Polished text', { mode: 'ai' });
    const { actions, stateRef } = setup(withReply('Fast text'));
    actions.polish();
    expect(stateRef.current.busy.ai).toBe(true);
    await vi.waitFor(() => expect(stateRef.current.reply.text).toBe('Polished text'));
    expect(calls[0]?.body).toEqual({ message: MESSAGE, macroIds: ['a'], variables: {}, mode: 'ai' });
    expect(stateRef.current.busy.ai).toBe(false);
  });

  it('keeps the fast text and toasts when AI fails', async () => {
    setState({ health: health(true) });
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'Budget exceeded' }), { status: 402 }));
    const { actions, stateRef } = setup(withReply('Fast text'));
    actions.polish();
    await vi.waitFor(() => expect(stateRef.current.busy.ai).toBe(false));
    expect(stateRef.current.reply.text).toBe('Fast text');
    expect(toastTexts()).toContain('AI polish failed: Budget exceeded. Keeping the fast version.');
  });
});

describe('AI double-check', () => {
  const aiAnswer = rerankFixture([recommendationFixture('b', { confidence: 93, reason: 'AI: best fit.' }), recommendationFixture('a', { confidence: 60 })]);

  /** A reducer-backed dispatch that also records the action types. */
  function store(initial: AssistState) {
    const ref = { current: initial };
    const types: string[] = [];
    const dispatch = (action: AssistAction) => {
      types.push(action.type);
      ref.current = assistReducer(ref.current, action);
    };
    return { ref, types, dispatch };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the server after the delay and applies the answer in place', async () => {
    vi.useFakeTimers();
    routes['POST /api/rerank'] = () => aiAnswer;
    const { ref, types, dispatch } = store(withReply('Fast text'));
    scheduleRerank(MESSAGE, dispatch);
    await vi.advanceTimersByTimeAsync(RERANK_DELAY_MS - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ route: 'POST /api/rerank', body: { message: MESSAGE } }]);
    await vi.waitFor(() => expect(types).toEqual(['rerankStarted', 'reranked']));
    expect(ref.current.rerank).toMatchObject({ status: 'done', topId: 'b' });
    expect(ref.current.result?.recommendations.map((r) => r.macroId)).toEqual(['a', 'b', 'c']);
    expect(ref.current.selectedIds).toEqual(['a']);
    expect(ref.current.reply.text).toBe('Fast text');
  });

  it('sends nothing when cancelled before the delay', async () => {
    vi.useFakeTimers();
    const { types, dispatch } = store(withReply('x'));
    scheduleRerank(MESSAGE, dispatch)();
    await vi.advanceTimersByTimeAsync(RERANK_DELAY_MS * 2);
    expect(calls).toEqual([]);
    expect(types).toEqual([]);
  });

  it('aborts a running check when cancelled and drops its indicator', async () => {
    let aborted = false;
    vi.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );
    const { ref, types, dispatch } = store(withReply('x'));
    const cancel = scheduleRerank(MESSAGE, dispatch, 0);
    await vi.waitFor(() => expect(ref.current.rerank.status).toBe('running'));
    cancel();
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(types).toEqual(['rerankStarted', 'rerankStopped']);
    expect(ref.current.rerank).toBe(IDLE_RERANK);
  });

  it('fails silently', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 }));
    const { ref, dispatch } = store(withReply('x'));
    scheduleRerank(MESSAGE, dispatch, 0);
    await vi.waitFor(() => expect(ref.current.rerank.status).toBe('failed'));
    expect(toastTexts()).toEqual([]);
  });

  it('runs once per shown result, only when enabled', () => {
    const shown = withReply('x');
    expect(shouldRerank(shown, true)).toBe(true);
    expect(shouldRerank(shown, false)).toBe(false);
    expect(shouldRerank({ ...shown, message: `${MESSAGE}!` }, true)).toBe(false);
    expect(shouldRerank({ ...shown, result: resultFixture({ recommendations: [] }) }, true)).toBe(false);
    expect(shouldRerank({ ...shown, rerank: { ...IDLE_RERANK, message: MESSAGE, status: 'done' } }, true)).toBe(false);
    expect(shouldRerank({ ...shown, rerank: { ...IDLE_RERANK, message: MESSAGE, status: 'failed' } }, true)).toBe(false);
    // A check cancelled mid-flight (still marked running until the reducer catches up) is started again.
    expect(shouldRerank({ ...shown, rerank: { ...IDLE_RERANK, message: MESSAGE, status: 'running' } }, true)).toBe(true);
    expect(shouldRerank({ ...shown, rerank: { ...IDLE_RERANK, message: 'older', status: 'done' } }, true)).toBe(true);
  });

  it('Alt+4 uses the AI suggestion like a quick-search pick, never on its own', async () => {
    const res = rerankFixture([recommendationFixture('d', { confidence: 90 })]);
    const state = [
      { type: 'rerankStarted', message: MESSAGE },
      { type: 'reranked', message: MESSAGE, res },
    ].reduce((s, a) => assistReducer(s, a as AssistAction), withReply('Fast text'));
    expect(state.selectedIds).toEqual(['a']);
    const { actions, stateRef } = setup(state);
    actions.pickAiSuggestion();
    expect(stateRef.current.selectedIds).toEqual(['d']);
    await vi.waitFor(() => expect(eventBodies()).toEqual([{ type: 'recommendation_selected', macroIds: ['d'] }]));

    const none = setup(withReply('x'));
    none.actions.pickAiSuggestion();
    expect(none.stateRef.current.selectedIds).toEqual(['a']);
  });
});

describe('draft and new macro', () => {
  it('drafts a reply for the current message with the agent variables', async () => {
    routes['POST /api/draft'] = () => draftFixture('Hi Marko,\n\n[ENTER ANSWER ABOUT PENDING WITHDRAWAL]');
    const start = assistReducer(assistReducer(withReply('x'), { type: 'customerName', value: 'Marko' }), { type: 'select', ids: [] });
    const { actions, stateRef } = setup(start);
    await actions.draft();
    expect(calls[0]).toEqual({ route: 'POST /api/draft', body: { message: MESSAGE, variables: { user: 'Marko' } } });
    expect(stateRef.current.reply.meta?.source).toBe('draft');
  });

  it('hands a templatized draft to the library', () => {
    const state = assistReducer(withReply('x'), { type: 'drafted', message: MESSAGE, res: draftFixture('Hi Marko, [ENTER ANSWER]') });
    const { actions } = setup(state);
    actions.createMacro();
    expect(JSON.parse(storage.get(NEW_MACRO_DRAFT_KEY) ?? '{}')).toEqual({
      body: 'Hi {{user}}, [ENTER ANSWER]',
      title: 'Where is my withdrawal?',
      intents: ['withdrawal_pending'],
    });
    expect(getState().page).toBe('library');
  });
});

describe('clipboard and clear', () => {
  it('reads the clipboard into a fresh conversation', async () => {
    const { actions, stateRef, focus } = setup({ ...withReply('x'), customerName: 'Old customer' });
    await actions.readClipboard();
    expect(stateRef.current.message).toBe('Clipboard customer message');
    expect(stateRef.current.customerName).toBe('');
    expect(focus).toHaveBeenCalled();
  });

  it('clears the page', () => {
    const { actions, stateRef } = setup(withReply('x'));
    actions.clear();
    expect(stateRef.current).toBe(INITIAL_ASSIST_STATE);
  });
});
