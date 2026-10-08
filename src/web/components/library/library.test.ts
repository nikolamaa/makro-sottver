import { describe, expect, it } from 'vitest';
import type { Category, Fact, Macro } from '../../../shared/types';
import {
  blankFact,
  draftFromMacro,
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
import { EMPTY_FILTERS, buildHaystack, filterAndSort, type MacroFilters } from './search';

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
