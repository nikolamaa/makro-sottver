/**
 * Assist page state machine (pure). Side effects - requests, events, toasts, clipboard - live in useAssist;
 * this reducer only decides how responses change the page, including the stale-response guards:
 * a recommendation/draft for an outdated message, or an AI reply for an outdated macro selection, is ignored.
 */
import type {
  DraftResponse,
  GuardrailIssue,
  Id,
  Intent,
  LlmUsage,
  PersonalizeMode,
  PersonalizeRequest,
  PersonalizeResponse,
  RecommendResponse,
} from '../../../shared/types';
import { INTENT_LABELS } from '../../../shared/types';
import { detectedVariables, requestVariables, templatizeReply } from './variables';

/** What the reply editor shows next to the text. */
export interface ReplyMeta {
  source: 'macro' | 'draft';
  mode: PersonalizeMode;
  llm: LlmUsage | null;
  guardrail: GuardrailIssue[];
  warnings: string[];
  unansweredQuestions: string[];
}

export interface ReplyState {
  /** Editor content (the agent may edit it). */
  text: string;
  /** Last generated text (fast, AI or draft): detects agent edits and feeds editRatio at copy time. */
  generated: string;
  meta: ReplyMeta | null;
  /** AI version that arrived after the agent had already edited the generated text. */
  pendingAi: PersonalizeResponse | null;
  /** Personalization request key the reply belongs to ('' for drafts / nothing). */
  key: string;
  /** The fast personalization request that produced the reply (reused by AI polish). */
  request: PersonalizeRequest | null;
  /** Request key whose fast personalization failed (not retried until the inputs change). */
  failedKey: string;
  /** Present when the reply was produced by /api/draft. */
  draft: DraftResponse | null;
}

export interface AssistState {
  message: string;
  /** Agent-entered customer name; overrides {{user}}. */
  customerName: string;
  /** Agent-entered variable values; override detected ones. */
  overrides: Record<string, string>;
  result: RecommendResponse | null;
  /** Message the current result (or error) was computed for. */
  resultFor: string;
  recError: string | null;
  /** Ordered macro ids: first = primary, the rest are combined into the same reply. */
  selectedIds: Id[];
  /** True when the agent chose the selection (it then survives message edits); false for auto-selection. */
  manualSelection: boolean;
  reply: ReplyState;
  busy: { ai: boolean; draft: boolean };
}

export type AssistAction =
  /** fresh = a new conversation (paste/clipboard): resets name, variables, selection and reply. */
  | { type: 'message'; message: string; fresh: boolean }
  | { type: 'customerName'; value: string }
  | { type: 'override'; name: string; value: string }
  | { type: 'recommended'; message: string; result: RecommendResponse }
  | { type: 'recommendFailed'; message: string; error: string }
  | { type: 'select'; ids: Id[] }
  | { type: 'fastReady'; key: string; request: PersonalizeRequest; res: PersonalizeResponse }
  | { type: 'fastFailed'; key: string }
  | { type: 'aiStarted' }
  | { type: 'aiReady'; key: string; res: PersonalizeResponse }
  | { type: 'aiStopped' }
  | { type: 'applyPendingAi' }
  | { type: 'draftStarted' }
  | { type: 'drafted'; message: string; res: DraftResponse }
  | { type: 'draftFailed' }
  | { type: 'edit'; text: string }
  | { type: 'clear' };

export const EMPTY_REPLY: ReplyState = {
  text: '',
  generated: '',
  meta: null,
  pendingAi: null,
  key: '',
  request: null,
  failedKey: '',
  draft: null,
};

export const INITIAL_ASSIST_STATE: AssistState = {
  message: '',
  customerName: '',
  overrides: {},
  result: null,
  resultFor: '',
  recError: null,
  selectedIds: [],
  manualSelection: false,
  reply: EMPTY_REPLY,
  busy: { ai: false, draft: false },
};

/**
 * Identifies one fast-personalization input: selection, macro versions (an edited macro is re-personalized),
 * agent variables and message.
 */
export function personalizeKey(macroIds: readonly Id[], macroVersions: string, message: string, variablesKey: string): string {
  return `${macroIds.join(',')}\u0000${macroVersions}\u0000${variablesKey}\u0000${message}`;
}

/** Macros selected automatically for a new result: the best one, unless nothing matches well. */
export function autoSelection(result: RecommendResponse): Id[] {
  const top = result.recommendations[0];
  return top && !result.noGoodMatch ? [top.macroId] : [];
}

function metaFromPersonalize(res: PersonalizeResponse): ReplyMeta {
  return {
    source: 'macro',
    mode: res.mode,
    llm: res.llm,
    guardrail: res.guardrail,
    warnings: res.warnings,
    unansweredQuestions: res.unansweredQuestions,
  };
}

function metaFromDraft(res: DraftResponse): ReplyMeta {
  return {
    source: 'draft',
    mode: res.llm ? 'ai' : 'fast',
    llm: res.llm,
    guardrail: res.guardrail,
    warnings: res.warnings,
    unansweredQuestions: [],
  };
}

function withGenerated(reply: ReplyState, res: PersonalizeResponse): ReplyState {
  return { ...reply, text: res.text, generated: res.text, meta: metaFromPersonalize(res), pendingAi: null };
}

function onMessage(state: AssistState, message: string, fresh: boolean): AssistState {
  if (message === state.message) return state;
  if (!message.trim()) {
    return { ...INITIAL_ASSIST_STATE, message, customerName: fresh ? '' : state.customerName, overrides: fresh ? {} : state.overrides };
  }
  if (!fresh) return { ...state, message };
  // New conversation: drop the previous customer's values and reply. If the current result already belongs to
  // this text no new request will run, so select from it right away.
  const reuse = state.result !== null && message === state.resultFor;
  return {
    ...state,
    message,
    customerName: '',
    overrides: {},
    selectedIds: reuse && state.result ? autoSelection(state.result) : [],
    manualSelection: false,
    reply: EMPTY_REPLY,
    busy: { ...state.busy, ai: false },
  };
}

/** The agent's own selection survives message edits while every selected macro is still recommended. */
function keepsManualSelection(state: AssistState, result: RecommendResponse): boolean {
  const ids = state.selectedIds;
  return state.manualSelection && ids.length > 0 && ids.every((id) => result.recommendations.some((r) => r.macroId === id));
}

function onRecommended(state: AssistState, message: string, result: RecommendResponse): AssistState {
  if (message !== state.message) return state;
  const manualSelection = keepsManualSelection(state, result);
  const selectedIds = manualSelection ? state.selectedIds : autoSelection(result);
  return {
    ...state,
    result,
    resultFor: message,
    recError: null,
    selectedIds,
    manualSelection,
    reply: selectedIds.length ? state.reply : EMPTY_REPLY,
    busy: selectedIds.length ? state.busy : { ...state.busy, ai: false },
  };
}

/** Pure reducer for the Assist page. */
export function assistReducer(state: AssistState, action: AssistAction): AssistState {
  switch (action.type) {
    case 'message':
      return onMessage(state, action.message, action.fresh);
    case 'customerName':
      return { ...state, customerName: action.value };
    case 'override':
      return { ...state, overrides: { ...state.overrides, [action.name]: action.value } };
    case 'recommended':
      return onRecommended(state, action.message, action.result);
    case 'recommendFailed':
      return action.message === state.message ? { ...state, result: null, resultFor: action.message, recError: action.error } : state;
    case 'select':
      return { ...state, selectedIds: action.ids, manualSelection: true, reply: { ...state.reply, pendingAi: null } };
    case 'fastReady':
      return {
        ...state,
        reply: { ...withGenerated(state.reply, action.res), key: action.key, request: action.request, failedKey: '', draft: null },
      };
    case 'fastFailed':
      return { ...state, reply: { ...state.reply, failedKey: action.key } };
    case 'aiStarted':
      return { ...state, busy: { ...state.busy, ai: true } };
    case 'aiStopped':
      return state.busy.ai ? { ...state, busy: { ...state.busy, ai: false } } : state;
    case 'aiReady': {
      const busy = { ...state.busy, ai: false };
      if (action.key !== state.reply.key) return { ...state, busy };
      const untouched = state.reply.text === state.reply.generated;
      const reply = untouched ? withGenerated(state.reply, action.res) : { ...state.reply, pendingAi: action.res };
      return { ...state, reply, busy };
    }
    case 'applyPendingAi':
      return state.reply.pendingAi ? { ...state, reply: withGenerated(state.reply, state.reply.pendingAi) } : state;
    case 'draftStarted':
      return { ...state, busy: { ...state.busy, draft: true } };
    case 'drafted': {
      const busy = { ...state.busy, draft: false };
      if (action.message !== state.message) return { ...state, busy };
      const reply: ReplyState = { ...EMPTY_REPLY, text: action.res.text, generated: action.res.text, meta: metaFromDraft(action.res), draft: action.res };
      return { ...state, selectedIds: [], manualSelection: false, reply, busy };
    }
    case 'draftFailed':
      return { ...state, busy: { ...state.busy, draft: false } };
    case 'edit':
      return { ...state, reply: { ...state.reply, text: action.text } };
    case 'clear':
      return INITIAL_ASSIST_STATE;
  }
}

/** Payload handed to the Library page (sessionStorage 'macropilot.newMacroDraft') to create a macro. */
export interface NewMacroDraft {
  body: string;
  title: string;
  intents: Intent[];
}

export const NEW_MACRO_DRAFT_KEY = 'macropilot.newMacroDraft';

/**
 * Build the "Create new macro" draft from the current reply. Personal values (name, email, tx hash...) are
 * turned back into {{variables}} so customer data does not end up in the library. The title is the draft's
 * suggestion, else the top intent's label.
 */
export function buildNewMacroDraft(state: AssistState): NewMacroDraft {
  const analysis = state.result?.analysis;
  const detected = state.result?.detectedVariables ?? detectedVariables(analysis?.entities ?? []);
  const values = { ...detected, ...requestVariables(state.customerName, state.overrides) };
  const topIntent = analysis?.intents[0]?.intent;
  return {
    body: templatizeReply(state.reply.text, values),
    title: state.reply.draft?.suggestedTitle || (topIntent ? INTENT_LABELS[topIntent] : 'New macro'),
    intents: state.reply.draft?.suggestedIntents ?? analysis?.intents.slice(0, 2).map((i) => i.intent) ?? [],
  };
}
