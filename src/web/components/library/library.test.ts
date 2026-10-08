import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Category, Fact, Macro } from '../../../shared/types';
import { DIFF_TIMEOUT_MS, visibleWhitespace, wordDiff } from './diffing';
import {
  blankFact,
  draftFromMacro,
  dropBlankFact,
  latestKnownMacro,
  draftSignature,
  draftToInput,
  emptyDraft,
  parseSeed,
  parseTags,
  parseTriggers,
  patchFact,
  validateDraft,
  type MacroDraft,
} from './model';
import { EMPTY_FILTERS, buildHaystack, countLabel, filterAndSort, type MacroFilters } from './search';
import { createUnsavedStash } from './stash';
import { focusAfterModal, isModalOpen } from './Modals';

function fact(over: Partial<Fact> = {}): Fact {
  return {
    id: 'f1',
    macroId: 'm1',
    key: 'crypto.withdrawal.min_btc',
    statement: 'Minimum BTC withdrawal is 0.0002 BTC.',
    value: '0.0002 BTC',
    sourceUrl: 'https://help.stake.com/en/articles/1',
    evidenceQuote: 'The minimum withdrawal is 0.0002 BTC.',
    status: 'verified',
    lastCheckedAt: '2026-10-01T10:00:00.000Z',
    ...over,
  };
}

function macro(over: Partial<Macro> = {}): Macro {
  return {
    id: 'm1',
    title: 'Withdrawal pending',
    body: 'Hi {{user|there}},\n\nYour {{crypto}} withdrawal is being processed.',
    categoryId: null,
    tags: ['crypto', 'withdrawal'],
    intents: ['withdrawal_pending'],
    triggers: ['where is my withdrawal'],
    notes: '',
    shortcut: 'wd-pending',
    version: 1,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    archivedAt: null,
    isFavorite: false,
    useCount: 0,
    lastUsedAt: null,
    verification: 'verified',
    facts: [fact()],
    ...over,
  };
}

describe('library model', () => {
  it('parses comma separated tags and line separated triggers like the server (trim + case-insensitive dedupe)', () => {
    expect(parseTags(' vip, Crypto ,crypto,, btc ')).toEqual(['vip', 'Crypto', 'btc']);
    expect(parseTriggers('where is my money\n\n  Where is my money \r\nstill pending')).toEqual(['where is my money', 'still pending']);
  });

  it('a freshly loaded draft is not dirty; whitespace-only edits do not count as changes', () => {
    const m = macro();
    const base = draftSignature(draftFromMacro(m));
    const d = draftFromMacro(m);
    expect(draftSignature(d)).toBe(base);
    expect(draftSignature({ ...d, tagsText: 'crypto ,  withdrawal', title: ' Withdrawal pending ' })).toBe(base);
    expect(draftSignature({ ...d, title: 'Withdrawal pending (BTC)' })).not.toBe(base);
  });

  it('keeps fact ids and only sends a status when it changed', () => {
    const d = draftFromMacro(macro());
    const input = draftToInput(d, '  ');
    expect(input.changeNote).toBeUndefined();
    expect(input.facts).toEqual([
      {
        id: 'f1',
        key: 'crypto.withdrawal.min_btc',
        statement: 'Minimum BTC withdrawal is 0.0002 BTC.',
        value: '0.0002 BTC',
        sourceUrl: 'https://help.stake.com/en/articles/1',
        evidenceQuote: 'The minimum withdrawal is 0.0002 BTC.',
      },
    ]);
  });

  it('resets a verified fact to unchecked when its content changes, and back when the change is undone', () => {
    const f = draftFromMacro(macro()).facts[0]!;
    const edited = patchFact(f, { value: '0.0003 BTC' });
    expect(edited.status).toBe('unchecked');
    expect(edited.statusAuto).toBe(true);
    const undone = patchFact(edited, { value: '0.0002 BTC' });
    expect(undone.status).toBe('verified');
    expect(undone.statusAuto).toBe(false);
    // A status picked by the agent is kept.
    const manual = patchFact(patchFact(f, { status: 'outdated' }), { statement: 'Changed.' });
    expect(manual.status).toBe('outdated');

    const d: MacroDraft = { ...draftFromMacro(macro()), facts: [edited] };
    expect(draftToInput(d, 'Updated minimum').facts?.[0]).toMatchObject({ id: 'f1', status: 'unchecked', value: '0.0003 BTC' });
    expect(draftToInput(d, 'Updated minimum').changeNote).toBe('Updated minimum');
  });

  it('drops blank new facts and sends new facts with their status', () => {
    const d = draftFromMacro(macro({ facts: [] }));
    const added = patchFact(blankFact(), { statement: 'KYC takes up to 48 hours.', sourceUrl: '' });
    const input = draftToInput({ ...d, facts: [blankFact(), added] }, '');
    expect(input.facts).toEqual([{ key: '', statement: 'KYC takes up to 48 hours.', value: '', sourceUrl: null, evidenceQuote: null, status: 'unchecked' }]);
  });

  it('validates required fields, limits and source URLs', () => {
    expect(validateDraft(emptyDraft(), '').map((i) => i.field)).toEqual(['title', 'body']);
    const bad = { ...draftFromMacro(macro()), facts: [patchFact(blankFact(), { statement: 'x', sourceUrl: 'javascript:alert(1)' })] };
    const issues = validateDraft(bad, '');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'facts' });
    const noStatement = { ...draftFromMacro(macro()), facts: [patchFact(blankFact(), { key: 'a.b' })] };
    expect(validateDraft(noStatement, '')[0]?.message).toMatch(/statement is required/);
    expect(validateDraft(draftFromMacro(macro()), 'x'.repeat(501))[0]?.field).toBe('changeNote');
  });

  it('parses the new-macro seed defensively', () => {
    expect(parseSeed(null)).toBeNull();
    expect(parseSeed({ foo: 1 })).toBeNull();
    expect(parseSeed({ title: 'T', body: 'B', intents: ['kyc_verification', 'nope', 'kyc_verification'] })).toEqual({
      title: 'T',
      body: 'B',
      intents: ['kyc_verification'],
    });
    expect(emptyDraft({ title: 'T', intents: ['general'] })).toMatchObject({ title: 'T', body: '', intents: ['general'] });
  });
});

describe('library search', () => {
  const categories: Category[] = [
    { id: 'c1', name: 'Payments', color: '#4f7cff', sort: 1 },
    { id: 'c2', name: 'Account', color: '#19a974', sort: 2 },
  ];
  const macros: Macro[] = [
    macro({ id: 'a', title: 'Withdrawal pending', categoryId: 'c1', useCount: 3, lastUsedAt: '2026-10-05T10:00:00.000Z' }),
    macro({
      id: 'b',
      title: 'KYC level 2 documents',
      shortcut: 'kyc2',
      tags: ['verification'],
      categoryId: 'c2',
      body: 'Please upload a proof of address.',
      useCount: 10,
      isFavorite: true,
      verification: 'outdated',
      updatedAt: '2026-10-07T10:00:00.000Z',
    }),
    macro({ id: 'c', title: 'Deposit not credited', shortcut: '', tags: [], body: 'Please send the TX hash.', verification: 'verified' }),
  ];
  const haystack = buildHaystack(macros, categories);
  const run = (f: Partial<MacroFilters>, sort: Parameters<typeof filterAndSort>[3] = 'title') =>
    filterAndSort(macros, haystack, { ...EMPTY_FILTERS, ...f }, sort).map((m) => m.id);

  it('fuzzy matches titles with typos, shortcuts, tags and categories', () => {
    expect(run({ query: 'withdrawl' }, 'relevance')[0]).toBe('a');
    expect(run({ query: 'kyc2' }, 'relevance')).toEqual(['b']);
    expect(run({ query: 'verification' }, 'relevance')[0]).toBe('b');
    expect(run({ query: 'payments' }, 'relevance')).toContain('a');
  });

  it('falls back to a body substring search', () => {
    expect(run({ query: 'tx hash' }, 'relevance')).toEqual(['c']);
  });

  it('applies category, favorites and needs-attention filters', () => {
    expect(run({ category: 'c2' })).toEqual(['b']);
    expect(run({ category: 'none' })).toEqual(['c']);
    expect(run({ favorites: true })).toEqual(['b']);
    expect(run({ attention: true })).toEqual(['b']);
  });

  it('sorts by title, usage and recency', () => {
    expect(run({})).toEqual(['c', 'b', 'a']);
    expect(run({}, 'mostUsed')).toEqual(['b', 'a', 'c']);
    expect(run({}, 'recentlyUsed')[0]).toBe('a');
    expect(run({}, 'recentlyUpdated')[0]).toBe('b');
  });
});

describe('library review fixes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('archive/revert after "Save and continue" use the just-saved macro, not the stale editor snapshot', () => {
    // Bug: the guarded archive action captured the macro before the save; the archived copy (shown read-only and
    // kept in the archived list) then had the pre-save content.
    const stale = macro({ title: 'Before save', version: 2, updatedAt: '2026-10-08T10:00:00.000Z' });
    const saved = macro({ title: 'After save', version: 3, updatedAt: '2026-10-08T10:05:00.000Z' });
    expect(latestKnownMacro('m1', [[saved], []], stale)?.title).toBe('After save');
    // Archived list is searched too; an unknown id falls back to the snapshot only when it is the same macro.
    expect(latestKnownMacro('m1', [[], [saved]], null)?.title).toBe('After save');
    expect(latestKnownMacro('m1', [[], []], stale)?.title).toBe('Before save');
    expect(latestKnownMacro('other', [[saved], []], stale)).toBeNull();
    // A fact-only save keeps the version number: on a tie the store copy (with the new facts) wins.
    const factsSaved = macro({ version: 2, updatedAt: stale.updatedAt, facts: [] });
    expect(latestKnownMacro('m1', [[factsSaved]], stale)?.facts).toEqual([]);
    // A newer snapshot (store refreshed out of order) is kept.
    expect(latestKnownMacro('m1', [[stale]], saved)?.title).toBe('After save');
  });

  it('word diff is bounded in time: very different long bodies fall back to old/new instead of freezing the UI', () => {
    const words = (n: number, k: number) => Array.from({ length: n }, (_, i) => `w${(i * k) % 997}`).join(' ');
    const a = words(3000, 7);
    const b = words(3000, 13);
    const t0 = performance.now();
    const r = wordDiff(a, b);
    const elapsed = performance.now() - t0;
    expect(r.mode).toBe('whole');
    expect(r.parts).toEqual([
      { value: a, added: false, removed: true },
      { value: b, added: true, removed: false },
    ]);
    // Unbounded diffWords takes ~2 s for this input; the bounded one stops shortly after DIFF_TIMEOUT_MS.
    expect(elapsed).toBeLessThan(DIFF_TIMEOUT_MS + 1000);
  });

  it('word diff shows line-break-only changes (diffWords alone reports nothing changed)', () => {
    const r = wordDiff('Hi there,\n\nYour withdrawal is pending.', 'Hi there,\nYour withdrawal is pending.');
    expect(r.mode).toBe('whitespace');
    expect(r.parts.some((p) => (p.added || p.removed) && p.value.includes('\n'))).toBe(true);
    expect(visibleWhitespace(' \n\t')).toBe('·↵→');
    expect(visibleWhitespace('\n', true)).toBe('↵\n');
    // Regular word changes and identical texts.
    const w = wordDiff('Processing takes 24 hours', 'Processing takes 48 hours');
    expect(w.mode).toBe('words');
    expect(w.parts.filter((p) => p.removed).map((p) => p.value.trim())).toEqual(['24']);
    expect(w.parts.filter((p) => p.added).map((p) => p.value.trim())).toEqual(['48']);
    expect(wordDiff('same', 'same')).toEqual({ parts: [{ value: 'same', added: false, removed: false }], mode: 'same' });
    expect(wordDiff('', '').parts).toEqual([]);
  });

  it('a stashed unsaved draft keeps the browser reload/close prompt armed until it is restored', () => {
    // Bug: leaving the Library through quick search / Back kept the draft in memory but removed beforeunload,
    // so closing the tab afterwards lost the edits without a prompt.
    const listeners = new Map<string, Set<(e: unknown) => void>>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => listeners.get(type)?.delete(fn),
    });
    const armed = () => listeners.get('beforeunload')?.size ?? 0;
    const stash = createUnsavedStash<{ title: string }>();
    expect(armed()).toBe(0);
    stash.keep({ title: 'Draft' });
    stash.keep({ title: 'Draft 2' });
    expect(armed()).toBe(1);
    expect(stash.has()).toBe(true);
    const event = { preventDefault: vi.fn(), returnValue: 'x' };
    for (const fn of listeners.get('beforeunload') ?? []) fn(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe('');
    expect(stash.take()).toEqual({ title: 'Draft 2' });
    expect(armed()).toBe(0);
    expect(stash.take()).toBeNull();
    stash.keep({ title: 'Again' });
    stash.keep(null);
    expect(armed()).toBe(0);
  });

  it('leaving an untouched new fact (opening another one) drops it instead of leaving a "Statement missing" row', () => {
    const existing = draftFromMacro(macro()).facts[0]!;
    const fresh = blankFact();
    const facts = [existing, fresh];
    expect(dropBlankFact(facts, fresh.uid)).toEqual([existing]);
    // Facts with content are kept, and the same array is returned when nothing is dropped.
    expect(dropBlankFact(facts, existing.uid)).toBe(facts);
    expect(dropBlankFact(facts, 'missing')).toBe(facts);
    const typed = patchFact(fresh, { key: 'kyc.time' });
    expect(dropBlankFact([existing, typed], typed.uid)).toHaveLength(2);
  });

  it('closing a dialog returns focus instead of dropping it on <body> (keyboard-first)', () => {
    const list = { isConnected: true, name: 'list' };
    const deleteButton = { isConnected: true, name: 'delete' };
    // Cancel: back to the element focused before the dialog opened.
    expect(focusAfterModal(deleteButton, true, list)).toBe(deleteButton);
    // That element is gone (macro deleted): fall back to the macro list.
    expect(focusAfterModal({ isConnected: false, name: 'gone' }, true, list)).toBe(list);
    expect(focusAfterModal(null, true, list)).toBe(list);
    // The dialog's action already focused something (e.g. the new macro's title): leave it alone.
    expect(focusAfterModal(deleteButton, false, list)).toBeNull();
    // Page left (navigation): nothing to focus.
    expect(focusAfterModal(null, true, { isConnected: false, name: 'old list' })).toBeNull();
    expect(isModalOpen()).toBe(false);
  });

  it('list footer pluralizes the total ("1 of 4 macros")', () => {
    expect(countLabel(1, 4, true)).toBe('1 of 4 macros');
    expect(countLabel(1, 1, true)).toBe('1 of 1 macro');
    expect(countLabel(1, 1, false)).toBe('1 macro');
    expect(countLabel(0, 0, false)).toBe('0 macros');
    expect(countLabel(12, 12, false)).toBe('12 macros');
  });
});
