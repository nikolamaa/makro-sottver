import { describe, expect, it } from 'vitest';
import type { PersonalizeRequest } from '../../../shared/types';
import {
  assistReducer,
  autoSelection,
  buildNewMacroDraft,
  INITIAL_ASSIST_STATE,
  personalizeKey,
  type AssistAction,
  type AssistState,
} from './assistState';
import { analysisFixture, draftFixture, personalizeFixture, recommendationFixture, resultFixture } from './testFixtures';

const MESSAGE = 'Hi, I am Marko. Where is my withdrawal? Waiting 3 days!';
const REQUEST: PersonalizeRequest = { message: MESSAGE, macroIds: ['a'], variables: {}, mode: 'fast' };

function run(actions: AssistAction[], from: AssistState = INITIAL_ASSIST_STATE): AssistState {
  return actions.reduce(assistReducer, from);
}

function recommended(): AssistState {
  return run([
    { type: 'message', message: MESSAGE, fresh: true },
    { type: 'recommended', message: MESSAGE, result: resultFixture() },
  ]);
}

function withFastReply(text = 'Hi Marko, your withdrawal is pending.'): AssistState {
  return assistReducer(recommended(), { type: 'fastReady', key: 'k1', request: REQUEST, res: personalizeFixture(text) });
}

describe('assistReducer: message and recommendations', () => {
  it('auto-selects the best recommendation', () => {
    const s = recommended();
    expect(s.selectedIds).toEqual(['a']);
    expect(s.resultFor).toBe(MESSAGE);
    expect(s.result?.recommendations).toHaveLength(3);
  });

  it('does not auto-select when nothing matches well', () => {
    expect(autoSelection(resultFixture({ noGoodMatch: true }))).toEqual([]);
    expect(autoSelection(resultFixture({ recommendations: [] }))).toEqual([]);
  });

  it('ignores a recommendation for an outdated message', () => {
    const s = run([{ type: 'message', message: 'new text', fresh: false }], recommended());
    const after = assistReducer(s, { type: 'recommended', message: MESSAGE, result: resultFixture() });
    expect(after).toBe(s);
  });

  it('keeps name and variables while typing, resets them for a fresh conversation', () => {
    const base = run([
      { type: 'customerName', value: 'Ana' },
      { type: 'override', name: 'eta_time', value: '24 hours' },
    ], withFastReply());
    const typed = assistReducer(base, { type: 'message', message: `${MESSAGE}!`, fresh: false });
    expect(typed.customerName).toBe('Ana');
    expect(typed.overrides).toEqual({ eta_time: '24 hours' });
    expect(typed.reply.text).toBe(base.reply.text);

    const pasted = assistReducer(base, { type: 'message', message: 'Another customer', fresh: true });
    expect(pasted.customerName).toBe('');
    expect(pasted.overrides).toEqual({});
    expect(pasted.selectedIds).toEqual([]);
    expect(pasted.reply.text).toBe('');
  });

  it('keeps a still-recommended manual selection while the message is edited', () => {
    const combined = run([{ type: 'select', ids: ['b', 'c'] }, { type: 'message', message: `${MESSAGE} pls`, fresh: false }], recommended());
    const s = assistReducer(combined, { type: 'recommended', message: `${MESSAGE} pls`, result: resultFixture() });
    expect(s.selectedIds).toEqual(['b', 'c']);
    const gone = assistReducer(combined, {
      type: 'recommended',
      message: `${MESSAGE} pls`,
      result: resultFixture({ recommendations: [recommendationFixture('a'), recommendationFixture('b')] }),
    });
    expect(gone.selectedIds).toEqual(['a']);
    expect(gone.manualSelection).toBe(false);
  });

  it('lets an automatic selection follow the new best match', () => {
    const s = run([
      { type: 'message', message: `${MESSAGE} pls`, fresh: false },
      { type: 'recommended', message: `${MESSAGE} pls`, result: resultFixture({ recommendations: [recommendationFixture('b'), recommendationFixture('a')] }) },
    ], recommended());
    expect(s.selectedIds).toEqual(['b']);
  });

  it('re-selects from the current result when the same text is pasted as a new conversation', () => {
    const base = run([{ type: 'select', ids: ['c'] }, { type: 'message', message: 'typing', fresh: false }], recommended());
    const s = assistReducer(base, { type: 'message', message: MESSAGE, fresh: true });
    expect(s.selectedIds).toEqual(['a']);
    expect(s.reply.text).toBe('');
    const same = recommended();
    expect(assistReducer(same, { type: 'message', message: MESSAGE, fresh: true })).toBe(same);
  });

  it('clears everything for an empty message', () => {
    const s = assistReducer(withFastReply(), { type: 'message', message: '   ', fresh: false });
    expect(s.result).toBeNull();
    expect(s.selectedIds).toEqual([]);
    expect(s.reply.text).toBe('');
    expect(s.message).toBe('   ');
  });

  it('records recommendation errors for the current message only', () => {
    const s = assistReducer(recommended(), { type: 'recommendFailed', message: MESSAGE, error: 'boom' });
    expect(s.recError).toBe('boom');
    expect(s.result).toBeNull();
    expect(assistReducer(s, { type: 'recommendFailed', message: 'other', error: 'x' })).toBe(s);
  });

  it('clears an empty result reply when the new result has no selection', () => {
    const s = run([
      { type: 'message', message: 'something else', fresh: false },
      { type: 'recommended', message: 'something else', result: resultFixture({ noGoodMatch: true }) },
    ], withFastReply());
    expect(s.selectedIds).toEqual([]);
    expect(s.reply.text).toBe('');
  });
});

describe('assistReducer: reply', () => {
  it('fills the editor with the fast reply and remembers the request', () => {
    const s = withFastReply();
    expect(s.reply.text).toBe('Hi Marko, your withdrawal is pending.');
    expect(s.reply.generated).toBe(s.reply.text);
    expect(s.reply.key).toBe('k1');
    expect(s.reply.request).toEqual(REQUEST);
    expect(s.reply.meta?.mode).toBe('fast');
  });

  it('replaces an untouched reply with the AI version', () => {
    const ai = personalizeFixture('Hi Marko! Your withdrawal is still pending.', { mode: 'ai' });
    const s = run([{ type: 'aiStarted' }, { type: 'aiReady', key: 'k1', res: ai }], withFastReply());
    expect(s.reply.text).toBe(ai.text);
    expect(s.reply.generated).toBe(ai.text);
    expect(s.reply.meta?.mode).toBe('ai');
    expect(s.busy.ai).toBe(false);
  });

  it('keeps agent edits and offers the AI version instead', () => {
    const ai = personalizeFixture('AI text', { mode: 'ai' });
    const s = run([{ type: 'edit', text: 'My own words' }, { type: 'aiStarted' }, { type: 'aiReady', key: 'k1', res: ai }], withFastReply());
    expect(s.reply.text).toBe('My own words');
    expect(s.reply.pendingAi).toBe(ai);
    const applied = assistReducer(s, { type: 'applyPendingAi' });
    expect(applied.reply.text).toBe('AI text');
    expect(applied.reply.pendingAi).toBeNull();
  });

  it('drops an AI reply that belongs to an older request', () => {
    const s = run([{ type: 'aiStarted' }, { type: 'aiReady', key: 'old', res: personalizeFixture('stale') }], withFastReply());
    expect(s.reply.text).toBe('Hi Marko, your withdrawal is pending.');
    expect(s.busy.ai).toBe(false);
  });

  it('tracks failed personalization keys', () => {
    const s = assistReducer(recommended(), { type: 'fastFailed', key: 'k9' });
    expect(s.reply.failedKey).toBe('k9');
  });

  it('shows a draft and clears the selection', () => {
    const draft = draftFixture('Hi Marko,\n\n[ENTER ANSWER ABOUT PENDING WITHDRAWAL]');
    const s = run([{ type: 'draftStarted' }, { type: 'drafted', message: MESSAGE, res: draft }], withFastReply());
    expect(s.selectedIds).toEqual([]);
    expect(s.reply.text).toBe(draft.text);
    expect(s.reply.meta).toMatchObject({ source: 'draft', mode: 'fast' });
    expect(s.reply.draft).toBe(draft);
    expect(s.busy.draft).toBe(false);
  });

  it('ignores a draft for an outdated message', () => {
    const s = run([{ type: 'draftStarted' }, { type: 'message', message: 'changed', fresh: false }], recommended());
    const after = assistReducer(s, { type: 'drafted', message: MESSAGE, res: draftFixture('x') });
    expect(after.reply.text).toBe('');
    expect(after.busy.draft).toBe(false);
  });

  it('clears pending AI on selection change and resets on clear', () => {
    const s = run([{ type: 'edit', text: 'edited' }, { type: 'aiReady', key: 'k1', res: personalizeFixture('ai') }], withFastReply());
    expect(assistReducer(s, { type: 'select', ids: ['b'] }).reply.pendingAi).toBeNull();
    expect(assistReducer(s, { type: 'clear' })).toBe(INITIAL_ASSIST_STATE);
  });
});

describe('personalizeKey', () => {
  it('changes with selection, macro versions, message and variables', () => {
    const k = personalizeKey(['a'], '1', 'm', '{}');
    expect(personalizeKey(['a'], '1', 'm', '{}')).toBe(k);
    expect(personalizeKey(['a', 'b'], '1,1', 'm', '{}')).not.toBe(k);
    expect(personalizeKey(['a'], '2', 'm', '{}')).not.toBe(k);
    expect(personalizeKey(['a'], '1', 'm2', '{}')).not.toBe(k);
    expect(personalizeKey(['a'], '1', 'm', '{"user":"Ana"}')).not.toBe(k);
  });
});

describe('buildNewMacroDraft', () => {
  it('uses the draft suggestion and templatizes personal values', () => {
    const draft = draftFixture('Hi Marko,\n\n[ENTER ANSWER ABOUT PENDING WITHDRAWAL]');
    const s = run([{ type: 'drafted', message: MESSAGE, res: draft }], recommended());
    expect(buildNewMacroDraft(s)).toEqual({
      body: 'Hi {{user}},\n\n[ENTER ANSWER ABOUT PENDING WITHDRAWAL]',
      title: 'Where is my withdrawal?',
      intents: ['withdrawal_pending'],
    });
  });

  it('falls back to the top intent without a draft', () => {
    const s = {
      ...recommended(),
      result: resultFixture({ analysis: analysisFixture({ intents: [{ intent: 'kyc_verification', score: 0.7 }], entities: [] }) }),
    };
    expect(buildNewMacroDraft(s)).toEqual({ body: '', title: 'Verification (KYC)', intents: ['kyc_verification'] });
    expect(buildNewMacroDraft(INITIAL_ASSIST_STATE)).toEqual({ body: '', title: 'New macro', intents: [] });
  });
});
