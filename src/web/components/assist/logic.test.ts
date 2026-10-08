import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entity, Recommendation, RecommendResponse } from '../../../shared/types';
import {
  copyText,
  decideCopy,
  COPY_CONFIRM_WINDOW_MS,
  MAX_MESSAGE_CHARS,
  rememberAppCopy,
  shortcutReadsClipboard,
  shouldAdoptClipboard,
} from './clipboard';
import { formatCost, modeLabel, percent, plural, timingLabel, verificationBadge } from './format';
import { selectOnly, stepSelection, toggleCombine, uncoveredHint } from './selection';
import { selectNextOccurrence, selectNextPlaceholder, type SelectableText } from './textSelection';
import { detectedVariables, requestVariables, templatizeReply, variablesUsed } from './variables';

function entity(type: Entity['type'], value: string): Entity {
  return { type, value, raw: value, start: 0, end: value.length };
}

describe('variables', () => {
  it('maps entities to template variables, first occurrence wins', () => {
    const vars = detectedVariables([
      entity('name', 'Marko'),
      entity('name', 'Ana'),
      entity('amount', '250'),
      entity('crypto', 'BTC'),
      entity('tx_hash', '0xabc'),
      entity('duration', '3 days'),
      entity('url', 'https://x.io'),
    ]);
    expect(vars).toEqual({ user: 'Marko', amount: '250', crypto: 'BTC', currency: 'BTC', tx_hash: '0xabc' });
  });

  it('fills values exactly as the server does: by position, raw fallback, capitalized name', () => {
    const vars = detectedVariables([
      { type: 'email', value: '', raw: 'Ana@Mail.com ', start: 30, end: 43 },
      { type: 'name', value: 'john smith', raw: 'john smith', start: 11, end: 21 },
      { type: 'name', value: 'Ana', raw: 'Ana', start: 50, end: 53 },
    ]);
    expect(vars).toEqual({ user: 'John Smith', email: 'Ana@Mail.com' });
    expect(detectedVariables([entity('name', 'McDonald')]).user).toBe('McDonald');
  });

  it('strips a name typed in lowercase from a new-macro body (the server capitalizes it in the reply)', () => {
    const values = detectedVariables([entity('name', 'marko')]);
    expect(templatizeReply('Hi Marko, thanks for waiting.', values)).toBe('Hi {{user}}, thanks for waiting.');
  });

  it('keeps a fiat currency over the crypto fallback', () => {
    expect(detectedVariables([entity('crypto', 'USDT'), entity('currency', 'EUR')]).currency).toBe('EUR');
  });

  it('lists variables used by macro bodies without {{user}}', () => {
    expect(variablesUsed(['Hi {{user}}, your {{amount}} {{crypto}}', 'ETA {{eta_time}} for {{AMOUNT}}'])).toEqual([
      'amount',
      'crypto',
      'eta_time',
    ]);
  });

  it('builds request variables from trimmed overrides and the customer name', () => {
    expect(requestVariables('  Ana ', { eta_time: ' 24 hours ', amount: '   ' })).toEqual({ eta_time: '24 hours', user: 'Ana' });
    expect(requestVariables('', {})).toEqual({});
  });

  it('templatizes personal values as whole words only', () => {
    const text = 'Hi Marko, we checked tx 0xabc123 for marko@mail.com. Markov chains are unrelated.';
    expect(templatizeReply(text, { user: 'Marko', tx_hash: '0xabc123', email: 'marko@mail.com', amount: '25' })).toBe(
      'Hi {{user}}, we checked tx {{tx_hash}} for {{email}}. Markov chains are unrelated.',
    );
  });

  it('ignores very short values and never rewrites inside inserted variables', () => {
    expect(templatizeReply('Hi Al, user name is user', { user: 'Al', username: 'user' })).toBe('Hi Al, {{username}} name is {{username}}');
  });
});

describe('selection', () => {
  const recIds = ['a', 'b', 'c'];

  it('selects a single recommendation and reports no-ops as null', () => {
    expect(selectOnly([], recIds, 1)).toEqual(['b']);
    expect(selectOnly(['b'], recIds, 1)).toBeNull();
    expect(selectOnly(['a'], recIds, 5)).toBeNull();
  });

  it('toggles combined macros up to the limit and keeps the last one', () => {
    expect(toggleCombine(['a'], recIds, 1)).toEqual(['a', 'b']);
    expect(toggleCombine(['a', 'b'], recIds, 0)).toEqual(['b']);
    expect(toggleCombine(['a'], recIds, 0)).toBeNull();
    expect(toggleCombine(['a', 'b', 'x'], recIds, 2)).toBe('limit');
    expect(toggleCombine([], recIds, 2)).toEqual(['c']);
  });

  it('steps through recommendations with clamping', () => {
    expect(stepSelection(['a'], recIds, 1)).toEqual(['b']);
    expect(stepSelection(['c'], recIds, 1)).toBeNull();
    expect(stepSelection(['a'], recIds, -1)).toBeNull();
    expect(stepSelection([], recIds, -1)).toEqual(['c']);
    expect(stepSelection(['a', 'b'], recIds, -1)).toEqual(['a']);
    expect(stepSelection(['a'], [], 1)).toBeNull();
  });

  it('finds intents still uncovered by the selection and the card covering them', () => {
    const rec = (macroId: string, coversIntents: Recommendation['coversIntents']) => ({ macroId, coversIntents }) as Recommendation;
    const result = {
      recommendations: [rec('a', ['withdrawal_pending']), rec('b', ['kyc_verification']), rec('c', ['bonus_inquiry'])],
      uncoveredIntents: ['kyc_verification', 'bonus_inquiry'],
    } as RecommendResponse;
    expect(uncoveredHint(result, ['a'])).toEqual({ intents: ['kyc_verification', 'bonus_inquiry'], coverRank: 1 });
    expect(uncoveredHint(result, ['a', 'b'])).toEqual({ intents: ['bonus_inquiry'], coverRank: 2 });
    expect(uncoveredHint(result, ['a', 'b', 'c']).intents).toEqual([]);
  });
});

describe('copy guard', () => {
  it('copies immediately without placeholders and refuses empty text', () => {
    expect(decideCopy('Hello', 0, 1000)).toEqual({ action: 'copy' });
    expect(decideCopy('   ', 0, 1000)).toEqual({ action: 'empty' });
  });

  it('asks for confirmation, then copies on a second press within the window', () => {
    const first = decideCopy('ETA [ENTER ETA TIME], hash [ENTER TX HASH] [ENTER ETA TIME]', 0, 1000);
    expect(first).toEqual({ action: 'confirm', placeholders: 2, armedUntil: 1000 + COPY_CONFIRM_WINDOW_MS });
    const armed = first.action === 'confirm' ? first.armedUntil : 0;
    expect(decideCopy('ETA [ENTER ETA TIME]', armed, 2500)).toEqual({ action: 'copy' });
    expect(decideCopy('ETA [ENTER ETA TIME]', armed, armed + 1).action).toBe('confirm');
  });
});

describe('clipboard auto-read', () => {
  const empty = { message: '', reply: '' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adopts new text only', () => {
    expect(shouldAdoptClipboard('Where is my withdrawal?', empty)).toBe(true);
    expect(shouldAdoptClipboard('  ', empty)).toBe(false);
    expect(shouldAdoptClipboard('same text ', { message: ' same text', reply: '' })).toBe(false);
    expect(shouldAdoptClipboard('x'.repeat(MAX_MESSAGE_CHARS + 1), empty)).toBe(false);
  });

  it('ignores details the agent copied from the current message or reply', () => {
    const current = { message: 'My deposit 0xabc123def is missing, email ana@mail.com', reply: 'Hi Ana, we are checking it.' };
    expect(shouldAdoptClipboard('0xabc123def', current)).toBe(false);
    expect(shouldAdoptClipboard(' ana@mail.com ', current)).toBe(false);
    expect(shouldAdoptClipboard('we are checking it', current)).toBe(false);
    expect(shouldAdoptClipboard('Hello, my bonus did not arrive', current)).toBe(true);
  });

  it('ignores anything the app copied itself (replies, macro bodies, entity values)', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void writes.push(t) } });
    expect(await copyText('Hi Ana, your withdrawal was sent.')).toBe(true);
    expect(writes).toEqual(['Hi Ana, your withdrawal was sent.']);
    expect(shouldAdoptClipboard('Hi Ana, your withdrawal was sent.', empty)).toBe(false);
    rememberAppCopy('Macro body copied from quick search');
    expect(shouldAdoptClipboard('Macro body copied from quick search ', empty)).toBe(false);
  });

  it('forgets old app copies after a while', () => {
    rememberAppCopy('oldest app copy');
    for (let i = 0; i < 20; i++) rememberAppCopy(`copy ${i}`);
    expect(shouldAdoptClipboard('oldest app copy', empty)).toBe(true);
    expect(shouldAdoptClipboard('copy 19', empty)).toBe(false);
  });
});

describe('read clipboard shortcut', () => {
  class FakeElement {
    constructor(
      readonly tagName: string,
      readonly isContentEditable = false,
    ) {}
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the clipboard from the message box or the page, but leaves other text fields to the browser', () => {
    vi.stubGlobal('HTMLElement', FakeElement);
    const messageBox = new FakeElement('TEXTAREA') as unknown as HTMLElement;
    expect(shortcutReadsClipboard(messageBox, messageBox)).toBe(true);
    expect(shortcutReadsClipboard(new FakeElement('BUTTON') as unknown as HTMLElement, messageBox)).toBe(true);
    expect(shortcutReadsClipboard(null, messageBox)).toBe(true);
    expect(shortcutReadsClipboard(new FakeElement('TEXTAREA') as unknown as HTMLElement, messageBox)).toBe(false);
    expect(shortcutReadsClipboard(new FakeElement('INPUT') as unknown as HTMLElement, messageBox)).toBe(false);
    expect(shortcutReadsClipboard(new FakeElement('DIV', true) as unknown as HTMLElement, messageBox)).toBe(false);
  });
});

describe('format', () => {
  it('formats costs, percentages and labels', () => {
    expect(formatCost(0)).toBe('free');
    expect(formatCost(0.00031)).toBe('$0.0003');
    expect(formatCost(0.0123)).toBe('$0.012');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(percent(0.734)).toBe('73%');
    expect(percent(1.2)).toBe('100%');
    expect(plural(1, 'placeholder')).toBe('1 placeholder');
    expect(plural(3, 'placeholder')).toBe('3 placeholders');
  });

  it('labels the reply mode', () => {
    expect(modeLabel(null)).toBe('fast');
    expect(
      modeLabel({ provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 900, outputTokens: 200, costUsd: 0.0003, latencyMs: 700 }),
    ).toBe('AI · claude-haiku-5-5 · $0.0003');
  });

  it('formats the timing line', () => {
    const res = {
      timingMs: { analysis: 1.84, search: 9.2, total: 11 },
      embeddings: { provider: 'builtin', model: 'concepts', state: 'ready', detail: '' },
    } as Pick<RecommendResponse, 'timingMs' | 'embeddings'>;
    expect(timingLabel(res)).toBe('analysis 1.8 ms · search 9.2 ms · builtin');
    expect(timingLabel({ ...res, timingMs: { analysis: 12.4, search: 30.6, total: 43 } })).toBe('analysis 12 ms · search 31 ms · builtin');
  });

  it('maps verification statuses to badges', () => {
    expect(verificationBadge('verified')).toEqual({ tone: 'success', label: 'verified' });
    expect(verificationBadge('unverified')).toEqual({ tone: 'neutral', label: 'not verified' });
    expect(verificationBadge('outdated').tone).toBe('warning');
    expect(verificationBadge('conflict').tone).toBe('danger');
  });
});

describe('text selection', () => {
  function fakeTextarea(value: string, caret = 0): SelectableText & { selection: [number, number] } {
    return {
      value,
      selectionEnd: caret,
      selection: [caret, caret],
      setSelectionRange(start: number, end: number) {
        this.selection = [start, end];
        this.selectionEnd = end;
      },
      focus() {},
    };
  }

  it('cycles through occurrences of a placeholder', () => {
    const el = fakeTextarea('A [ENTER X] b [ENTER X]');
    expect(selectNextOccurrence(el, '[ENTER X]')).toBe(true);
    expect(el.selection).toEqual([2, 11]);
    selectNextOccurrence(el, '[ENTER X]');
    expect(el.selection).toEqual([14, 23]);
    selectNextOccurrence(el, '[ENTER X]');
    expect(el.selection).toEqual([2, 11]);
    expect(selectNextOccurrence(el, '[ENTER Y]')).toBe(false);
  });

  it('jumps to the next placeholder after the caret, wrapping around', () => {
    const el = fakeTextarea('Hi [ENTER USER], ETA is [ENTER ETA TIME].', 20);
    expect(selectNextPlaceholder(el)).toBe(true);
    expect(el.selection).toEqual([24, 40]);
    expect(selectNextPlaceholder(el)).toBe(true);
    expect(el.selection).toEqual([3, 15]);
    expect(selectNextPlaceholder(fakeTextarea('nothing here'))).toBe(false);
  });
});
