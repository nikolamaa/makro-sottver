import { describe, expect, it } from 'vitest';
import type { Category, Macro } from '../../../shared/types';
import { buildQuickSearchIndex, highlightSegments, searchMacros } from './quickSearch';

let seq = 0;
function macro(partial: Partial<Macro>): Macro {
  seq += 1;
  return {
    id: `m${seq}`,
    title: `Macro ${seq}`,
    body: 'Hi {{user}}, thanks for reaching out.',
    categoryId: null,
    tags: [],
    intents: [],
    triggers: [],
    notes: '',
    shortcut: '',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    isFavorite: false,
    useCount: 0,
    lastUsedAt: null,
    verification: 'unverified',
    facts: [],
    ...partial,
  };
}

const categories: Category[] = [{ id: 'c-pay', name: 'Payments', color: '#4f7cff', sort: 0 }];

describe('quick search', () => {
  const pending = macro({ title: 'Withdrawal pending', shortcut: 'wd-pending', tags: ['crypto'], categoryId: 'c-pay' });
  const limits = macro({ title: 'Withdrawal limits', shortcut: 'wd-limits', useCount: 12 });
  const kyc = macro({ title: 'KYC level 2 documents', shortcut: 'kyc-l2', isFavorite: true, useCount: 1 });
  const vault = macro({ title: 'Vault explained', body: 'The Vault keeps funds separate from your balance.' });
  const recent = macro({ title: 'Recently used', lastUsedAt: '2026-10-07T10:00:00.000Z' });
  const index = buildQuickSearchIndex([pending, limits, kyc, vault, recent], categories);

  it('orders favorites, then most used, then recent for an empty query', () => {
    const ids = searchMacros(index, '  ').map((h) => h.macro.id);
    expect(ids.slice(0, 3)).toEqual([kyc.id, limits.id, recent.id]);
    expect(ids).toHaveLength(5);
  });

  it('matches shortcuts, typos and out-of-order terms', () => {
    expect(searchMacros(index, 'wd-pend')[0]?.macro.id).toBe(pending.id);
    expect(searchMacros(index, 'withdrawl').map((h) => h.macro.id)).toEqual(expect.arrayContaining([pending.id, limits.id]));
    expect(searchMacros(index, 'pending withdrawal')[0]?.macro.id).toBe(pending.id);
  });

  it('matches category names and exposes them on hits', () => {
    const hits = searchMacros(index, 'payments');
    expect(hits[0]?.macro.id).toBe(pending.id);
    expect(hits[0]?.categoryName).toBe('Payments');
  });

  it('falls back to a substring search in bodies', () => {
    expect(searchMacros(index, 'separate from').map((h) => h.macro.id)).toEqual([vault.id]);
  });

  it('returns title highlight ranges only within the title', () => {
    const hit = searchMacros(index, 'kyc')[0]!;
    expect(hit.titleRanges).toEqual([0, 3]);
    expect(highlightSegments(hit.macro.title, hit.titleRanges)).toEqual([
      { text: 'KYC', match: true },
      { text: ' level 2 documents', match: false },
    ]);
  });

  it('respects the result limit', () => {
    expect(searchMacros(index, '', 2)).toHaveLength(2);
  });

  it('stays fast with 2000 macros', () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      macro({
        title: `Topic ${i} ${i % 2 ? 'withdrawal' : 'deposit'} ${i % 7 ? 'pending' : 'limits'}`,
        shortcut: `t-${i}`,
        tags: ['payments', `tag${i % 13}`],
        body: `Body text number ${i}. `.repeat(30),
        useCount: i % 17,
      }),
    );
    const big = buildQuickSearchIndex(many, categories);
    const queries = ['wd pend', 'deposit limits', 'topic 1999', 'xyz', 'number 42', 'a', ''];
    const t0 = performance.now();
    for (let round = 0; round < 5; round++) for (const q of queries) searchMacros(big, q);
    const perQuery = (performance.now() - t0) / (queries.length * 5);
    expect(perQuery).toBeLessThan(25);
    expect(searchMacros(big, 'topic 1999')[0]?.macro.title).toContain('Topic 1999');
  });
});

describe('highlightSegments', () => {
  it('returns the whole title when there are no ranges', () => {
    expect(highlightSegments('Hello', [])).toEqual([{ text: 'Hello', match: false }]);
  });

  it('splits around multiple ranges', () => {
    expect(highlightSegments('Withdrawal pending', [0, 4, 11, 14])).toEqual([
      { text: 'With', match: true },
      { text: 'drawal ', match: false },
      { text: 'pen', match: true },
      { text: 'ding', match: false },
    ]);
  });
});
