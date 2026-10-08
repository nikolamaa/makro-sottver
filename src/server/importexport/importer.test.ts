import { describe, expect, it } from 'vitest';
import type { Category, Fact, ImportItem, Macro } from '../../shared/types.js';
import { parseImport, toExportJson } from './importer.js';

const NO_EXISTING: Pick<Macro, 'id' | 'title'>[] = [];

function item(overrides: Partial<ImportItem>): ImportItem {
  return {
    title: '',
    body: '',
    category: null,
    tags: [],
    intents: [],
    triggers: [],
    notes: '',
    shortcut: '',
    facts: [],
    duplicateOf: null,
    ...overrides,
  };
}

function fact(overrides: Partial<Fact>): Fact {
  return {
    id: 'f1',
    macroId: 'm1',
    key: 'crypto.withdrawal.min_btc',
    statement: 'Minimum BTC withdrawal is 0.0002 BTC',
    value: '0.0002 BTC',
    sourceUrl: 'https://help.stake.com/en/articles/withdrawals',
    evidenceQuote: 'The minimum withdrawal amount for BTC is 0.0002',
    status: 'verified',
    lastCheckedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

function macro(overrides: Partial<Macro>): Macro {
  return {
    id: 'm1',
    version: 3,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    archivedAt: null,
    isFavorite: false,
    useCount: 7,
    lastUsedAt: null,
    verification: 'verified',
    title: 'Pending withdrawal',
    body: 'Hi {{user|there}},\n\nYour {{crypto}} withdrawal is pending.\n\nIt should arrive within {{eta_time}}.',
    categoryId: 'c1',
    tags: ['withdrawal', 'crypto'],
    intents: ['withdrawal_pending'],
    triggers: ['where is my withdrawal', 'withdrawal stuck'],
    notes: 'Check the tx hash first.',
    shortcut: 'wd-pending',
    facts: [],
    ...overrides,
  };
}

const CATEGORIES: Category[] = [
  { id: 'c1', name: 'Withdrawals', color: '#4f7cff', sort: 0 },
  { id: 'c2', name: 'Bonuses', color: '#ff9f43', sort: 1 },
];

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe('parseImport csv', () => {
  it('reads quoted multi-line bodies with commas, escaped quotes, a BOM and header synonyms', () => {
    const csv = [
      '\uFEFFMacro Name,Text,Folder,Labels,Intent,Example Questions,Internal_Note,Code',
      '"Pending withdrawal","Hi {{first_name | fallback: ""there""}},',
      '',
      'Your withdrawal is pending, it usually takes 10-30 minutes.","Withdrawals","crypto; withdrawal, Crypto","withdrawal_pending,Pending withdrawal","where is my withdrawal|withdrawal stuck","check tx hash","wd-pending"',
    ].join('\r\n');
    const preview = parseImport('csv', csv, NO_EXISTING);
    expect(preview.errors).toEqual([]);
    expect(preview.items).toEqual([
      item({
        title: 'Pending withdrawal',
        body: 'Hi {{user|there}},\n\nYour withdrawal is pending, it usually takes 10-30 minutes.',
        category: 'Withdrawals',
        tags: ['crypto', 'withdrawal'],
        intents: ['withdrawal_pending'],
        triggers: ['where is my withdrawal', 'withdrawal stuck'],
        notes: 'check tx hash',
        shortcut: 'wd-pending',
      }),
    ]);
  });

  it('defaults missing optional columns and ignores unknown ones', () => {
    const csv = 'title,body,owner\nKYC levels,"You can verify in Settings > Verification.",ana\n';
    const preview = parseImport('csv', csv, NO_EXISTING);
    expect(preview.errors).toEqual([]);
    expect(preview.items).toEqual([item({ title: 'KYC levels', body: 'You can verify in Settings > Verification.' })]);
  });

  it('rejects a header without title or body columns', () => {
    const preview = parseImport('csv', 'name,folder\nA,B\n', NO_EXISTING);
    expect(preview.items).toEqual([]);
    expect(preview.errors).toHaveLength(1);
    expect(preview.errors[0]).toContain('body column');
    expect(preview.errors[0]).not.toContain('title column');
  });

  it('reports bad rows with spreadsheet row numbers and keeps the good ones', () => {
    const csv = ['title,body', 'Good,Body one', 'No body,', ',Orphan body', ',,', '', 'Also good,Body two'].join('\n');
    const preview = parseImport('csv', csv, NO_EXISTING);
    expect(preview.items.map((i) => i.title)).toEqual(['Good', 'Also good']);
    expect(preview.errors).toEqual(['Row 3: missing body', 'Row 4: missing title']);
  });

  it('tolerates short and long rows (relaxed column count)', () => {
    const csv = 'title,body,tags\nShort row,Only two cells\nLong row,Body,a,extra,cells\n';
    const preview = parseImport('csv', csv, NO_EXISTING);
    expect(preview.errors).toEqual([]);
    expect(preview.items.map((i) => [i.title, i.tags])).toEqual([
      ['Short row', []],
      ['Long row', ['a']],
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    const semicolon = parseImport('csv', 'Title;Body;Tags\nBonus;"Claim it, then wager.";bonus, reload\n', NO_EXISTING);
    expect(semicolon.items).toEqual([item({ title: 'Bonus', body: 'Claim it, then wager.', tags: ['bonus', 'reload'] })]);
    const tab = parseImport('csv', 'Title\tBody\nBonus\tClaim it, then wager.\n', NO_EXISTING);
    expect(tab.items).toEqual([item({ title: 'Bonus', body: 'Claim it, then wager.' })]);
  });

  it('reads facts from a JSON array cell and reports invalid fact JSON without dropping the macro', () => {
    const facts = JSON.stringify([{ statement: 'Minimum deposit is 10 USD', value: '10 USD', source_url: 'https://help.stake.com/en/', status: 'verified' }]);
    const csv = `title,body,facts\nMin deposit,The minimum is 10 USD.,"${facts.replaceAll('"', '""')}"\nBroken,Body,"[{not json"\n`;
    const preview = parseImport('csv', csv, NO_EXISTING);
    expect(preview.items[0]?.facts).toEqual([
      {
        key: 'minimum_deposit_is_10_usd',
        statement: 'Minimum deposit is 10 USD',
        value: '10 USD',
        sourceUrl: 'https://help.stake.com/en/',
        evidenceQuote: null,
        status: 'verified',
      },
    ]);
    expect(preview.items[1]?.facts).toEqual([]);
    expect(preview.errors).toEqual(['Row 3: facts are not valid JSON and were skipped']);
  });

  it('accepts a single fact object in the facts cell', () => {
    const csv = 'title,body,facts\nT,B,"{""statement"": ""VIP host from Platinum IV"", ""status"": ""unchecked""}"\n';
    const preview = parseImport('csv', csv, NO_EXISTING);
    expect(preview.errors).toEqual([]);
    expect(preview.items[0]?.facts).toEqual([
      { key: 'vip_host_from_platinum_iv', statement: 'VIP host from Platinum IV', value: '', sourceUrl: null, evidenceQuote: null, status: 'unchecked' },
    ]);
  });

  it('reports unreadable CSV instead of throwing', () => {
    const preview = parseImport('csv', 'title,body\n"unclosed,quote\n', NO_EXISTING);
    expect(preview.items).toEqual([]);
    expect(preview.errors[0]).toMatch(/^The CSV could not be read/);
  });

  it('detects the delimiter from the header even when the paste starts with blank lines', () => {
    const semicolon = parseImport('csv', '\r\n  \n\nTitle;Body;Tags\nBonus;Claim it, then wager.;bonus\n', NO_EXISTING);
    expect(semicolon.errors).toEqual([]);
    expect(semicolon.items).toEqual([item({ title: 'Bonus', body: 'Claim it, then wager.', tags: ['bonus'] })]);
    const tab = parseImport('csv', '\n\nTitle\tBody\nBonus\tClaim it, then wager.\n', NO_EXISTING);
    expect(tab.items).toEqual([item({ title: 'Bonus', body: 'Claim it, then wager.' })]);
  });
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

describe('parseImport json', () => {
  it('reads a bare array with flexible keys, list strings and fact synonyms', () => {
    const json = JSON.stringify([
      {
        name: 'Missing deposit',
        content: 'Hi {{ name | fallback: "there" }}, please share the {{TX Hash}}.',
        group: 'Deposits',
        labels: 'deposit, crypto',
        intent: ['Missing deposit', 'deposit-help'],
        examples: 'my deposit is missing\ndeposit not credited',
        note: 'Ask for tx hash',
        key: 'dep-missing',
        facts: [
          { statement: 'Deposits need 1 confirmation', source_url: 'https://help.stake.com/en/a', evidence_quote: '1 confirmation', status: 'bogus' },
          'BTC deposits are credited after 1 confirmation',
        ],
      },
    ]);
    const preview = parseImport('json', json, NO_EXISTING);
    expect(preview.errors).toEqual([]);
    expect(preview.items).toEqual([
      item({
        title: 'Missing deposit',
        body: 'Hi {{user|there}}, please share the {{tx_hash}}.',
        category: 'Deposits',
        tags: ['deposit', 'crypto'],
        intents: ['deposit_missing', 'deposit_help'],
        triggers: ['my deposit is missing', 'deposit not credited'],
        notes: 'Ask for tx hash',
        shortcut: 'dep-missing',
        facts: [
          {
            key: 'deposits_need_1_confirmation',
            statement: 'Deposits need 1 confirmation',
            value: '',
            sourceUrl: 'https://help.stake.com/en/a',
            evidenceQuote: '1 confirmation',
          },
          {
            key: 'btc_deposits_are_credited_after_1_confirmation',
            statement: 'BTC deposits are credited after 1 confirmation',
            value: '',
            sourceUrl: null,
            evidenceQuote: null,
          },
        ],
      }),
    ]);
  });

  it('reads {macros: [...]} and a single macro object', () => {
    const wrapped = parseImport('json', JSON.stringify({ macros: [{ title: 'A', body: 'Body A' }] }), NO_EXISTING);
    expect(wrapped.items).toEqual([item({ title: 'A', body: 'Body A' })]);
    const single = parseImport('json', JSON.stringify({ title: 'B', text: 'Body B' }), NO_EXISTING);
    expect(single.items).toEqual([item({ title: 'B', body: 'Body B' })]);
  });

  it('resolves categoryId through the categories list of the export format', () => {
    const json = JSON.stringify({
      format: 'macropilot-macros',
      version: 1,
      categories: [{ id: 'c9', name: 'VIP', color: '#000' }],
      macros: [
        { title: 'By id', body: 'x', categoryId: 'c9' },
        { title: 'By name', body: 'y', categoryId: 'c9', category: 'Bonuses' },
        { title: 'Unknown id', body: 'z', categoryId: 'nope' },
      ],
    });
    const preview = parseImport('json', json, NO_EXISTING);
    expect(preview.items.map((i) => i.category)).toEqual(['VIP', 'Bonuses', null]);
  });

  it('gives unique keys to facts that share a key', () => {
    const json = JSON.stringify([{ title: 'T', body: 'B', facts: [{ key: 'k', statement: 'one' }, { key: 'k', statement: 'two' }] }]);
    expect(parseImport('json', json, NO_EXISTING).items[0]?.facts.map((f) => f.key)).toEqual(['k', 'k_2']);
  });

  it('keeps de-duplicated fact keys within the 200 character key limit', () => {
    const longKey = 'k'.repeat(200);
    const json = JSON.stringify([{ title: 'T', body: 'B', facts: [{ key: longKey, statement: 'one' }, { key: longKey, statement: 'two' }] }]);
    const preview = parseImport('json', json, NO_EXISTING);
    expect(preview.errors).toEqual([]);
    const keys = preview.items[0]?.facts.map((f) => f.key) ?? [];
    expect(keys).toEqual([longKey, `${'k'.repeat(198)}_2`]);
    expect(keys.every((k) => k.length <= 200)).toBe(true);
  });

  it('stops reading facts once 100 were kept instead of processing the rest of a huge list', () => {
    const valid = Array.from({ length: 100 }, () => ({ key: 'same', statement: 'Deposits need 1 confirmation' }));
    const invalid = Array.from({ length: 5000 }, () => 42);
    const preview = parseImport('json', JSON.stringify([{ title: 'T', body: 'B', facts: [...valid, ...invalid] }]), NO_EXISTING);
    const keys = preview.items[0]?.facts.map((f) => f.key) ?? [];
    expect(keys).toHaveLength(100);
    expect(new Set(keys).size).toBe(100);
    expect(keys.at(-1)).toBe('same_100');
    // The 5000 entries after the limit are not inspected (each would otherwise be reported as a bad fact).
    expect(preview.errors).toEqual(['Item 1: only the first 100 facts were kept']);
  });

  it('drops fact sources that are not http(s) links and reports them, keeping the fact', () => {
    const json = JSON.stringify([
      {
        title: 'T',
        body: 'B',
        facts: [
          { statement: 'Min deposit is 10 USD', source: 'Confluence: Payments page' },
          { statement: 'Min BTC withdrawal', source_url: 'javascript:alert(1)' },
          { statement: 'KYC levels', source: 'https://help.stake.com/en/articles/kyc' },
        ],
      },
    ]);
    const preview = parseImport('json', json, NO_EXISTING);
    expect(preview.items[0]?.facts.map((f) => [f.statement, f.sourceUrl])).toEqual([
      ['Min deposit is 10 USD', null],
      ['Min BTC withdrawal', null],
      ['KYC levels', 'https://help.stake.com/en/articles/kyc'],
    ]);
    expect(preview.errors).toEqual([
      'Item 1, fact 1: source "Confluence: Payments page" is not an http(s) link and was dropped',
      'Item 1, fact 2: source "javascript:alert(1)" is not an http(s) link and was dropped',
    ]);
  });

  it('accepts a hand-edited string version "1" in the export format', () => {
    const json = JSON.stringify({ format: 'macropilot-macros', version: '1', macros: [{ title: 'A', body: 'Hi {{name}}' }] });
    const preview = parseImport('json', json, NO_EXISTING);
    expect(preview.errors).toEqual([]);
    expect(preview.items).toEqual([item({ title: 'A', body: 'Hi {{name}}' })]);
    expect(parseImport('json', '{"format":"macropilot-macros","version":"2","macros":[]}', NO_EXISTING).errors).toEqual([
      'Unsupported export version "2"; this app reads version 1.',
    ]);
  });

  it('reports invalid JSON, unsupported versions, wrong shapes and non-object items', () => {
    expect(parseImport('json', '{"macros": [', NO_EXISTING).errors[0]).toMatch(/^The JSON could not be read/);
    expect(parseImport('json', '{"format":"macropilot-macros","version":2,"macros":[]}', NO_EXISTING).errors).toEqual([
      'Unsupported export version 2; this app reads version 1.',
    ]);
    expect(parseImport('json', '"just a string"', NO_EXISTING).errors).toEqual([
      'The JSON must be a list of macros or an object with a "macros" list.',
    ]);
    expect(parseImport('json', '{"macros": {"title": "x"}}', NO_EXISTING).errors).toEqual(['"macros" must be a list.']);
    const mixed = parseImport('json', JSON.stringify([{ title: 'Ok', body: 'Fine' }, 'nope', { title: 'No body' }]), NO_EXISTING);
    expect(mixed.items.map((i) => i.title)).toEqual(['Ok']);
    expect(mixed.errors).toEqual(['Item 2: expected an object with a title and body', 'Item 3: missing body']);
  });

  it('reports facts without a statement and keeps the macro', () => {
    const json = JSON.stringify([{ title: 'T', body: 'B', facts: [{ value: '10' }, 42, { statement: 'ok' }] }]);
    const preview = parseImport('json', json, NO_EXISTING);
    expect(preview.items[0]?.facts.map((f) => f.statement)).toEqual(['ok']);
    expect(preview.errors).toEqual(['Item 1, fact 1: missing statement', 'Item 1, fact 2: expected an object with a statement']);
  });
});

// ---------------------------------------------------------------------------
// Export + roundtrip
// ---------------------------------------------------------------------------

describe('toExportJson', () => {
  const macros = [
    macro({
      facts: [
        fact({}),
        fact({ id: 'f2', key: 'crypto.withdrawal.eta', statement: 'ETA is 10 minutes', value: '10 minutes', sourceUrl: null, evidenceQuote: null, status: 'outdated' }),
      ],
    }),
    macro({
      id: 'm2',
      title: 'Weekly bonus',
      body: 'Hi {{name}}, your {{bonus_name|weekly bonus}} is live.',
      categoryId: 'c2',
      isFavorite: true,
      archivedAt: '2026-10-02T00:00:00.000Z',
      intents: ['bonus_inquiry'],
      facts: [fact({ id: 'f3', key: 'bonus.weekly.day', statement: 'Weekly bonus drops on Saturday', status: 'contradicted' })],
    }),
    macro({ id: 'm3', title: 'No category', categoryId: null, facts: [] }),
  ];

  it('writes the documented, pretty-printed export format', () => {
    const json = toExportJson(macros, CATEGORIES, new Date('2026-10-08T12:00:00.000Z'));
    expect(json.split('\n')[1]).toBe('  "format": "macropilot-macros",');
    const file = JSON.parse(json) as Record<string, unknown>;
    expect(file).toMatchObject({
      format: 'macropilot-macros',
      version: 1,
      exportedAt: '2026-10-08T12:00:00.000Z',
      categories: [
        { id: 'c1', name: 'Withdrawals', color: '#4f7cff' },
        { id: 'c2', name: 'Bonuses', color: '#ff9f43' },
      ],
    });
    const exported = file.macros as Record<string, unknown>[];
    expect(exported[1]).toEqual({
      id: 'm2',
      title: 'Weekly bonus',
      body: 'Hi {{name}}, your {{bonus_name|weekly bonus}} is live.',
      categoryId: 'c2',
      category: 'Bonuses',
      tags: ['withdrawal', 'crypto'],
      intents: ['bonus_inquiry'],
      triggers: ['where is my withdrawal', 'withdrawal stuck'],
      notes: 'Check the tx hash first.',
      shortcut: 'wd-pending',
      isFavorite: true,
      archived: true,
      facts: [
        {
          key: 'bonus.weekly.day',
          statement: 'Weekly bonus drops on Saturday',
          value: '0.0002 BTC',
          sourceUrl: 'https://help.stake.com/en/articles/withdrawals',
          evidenceQuote: 'The minimum withdrawal amount for BTC is 0.0002',
          status: 'contradicted',
        },
      ],
    });
    expect(exported[0]?.archived).toBe(false);
    expect(exported[2]?.category).toBeNull();
  });

  it('round-trips through parseImport, keeping bodies verbatim and fact statuses', () => {
    const preview = parseImport('json', toExportJson(macros, CATEGORIES), NO_EXISTING);
    expect(preview.errors).toEqual([]);
    expect(preview.items).toHaveLength(3);
    const [first, second, third] = preview.items;
    expect(first).toEqual(
      item({
        title: 'Pending withdrawal',
        body: macros[0]?.body,
        category: 'Withdrawals',
        tags: ['withdrawal', 'crypto'],
        intents: ['withdrawal_pending'],
        triggers: ['where is my withdrawal', 'withdrawal stuck'],
        notes: 'Check the tx hash first.',
        shortcut: 'wd-pending',
        facts: [
          {
            key: 'crypto.withdrawal.min_btc',
            statement: 'Minimum BTC withdrawal is 0.0002 BTC',
            value: '0.0002 BTC',
            sourceUrl: 'https://help.stake.com/en/articles/withdrawals',
            evidenceQuote: 'The minimum withdrawal amount for BTC is 0.0002',
            status: 'verified',
          },
          { key: 'crypto.withdrawal.eta', statement: 'ETA is 10 minutes', value: '10 minutes', sourceUrl: null, evidenceQuote: null, status: 'outdated' },
        ],
      }),
    );
    // Native export: {{name}} is a MacroPilot variable here, not an Intercom attribute.
    expect(second?.body).toBe('Hi {{name}}, your {{bonus_name|weekly bonus}} is live.');
    expect(second?.category).toBe('Bonuses');
    expect(second?.facts[0]?.status).toBe('contradicted');
    expect(third?.category).toBeNull();
  });

  it('exports an empty library as a valid, importable file', () => {
    const json = toExportJson([], []);
    expect(JSON.parse(json)).toMatchObject({ format: 'macropilot-macros', version: 1, categories: [], macros: [] });
    expect(parseImport('json', json, NO_EXISTING).errors).toEqual(['No macros found in the content.']);
  });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

describe('parseImport text', () => {
  it('splits "---" blocks, reads header lines and keeps internal blank lines (Windows line endings)', () => {
    const text = [
      '  ',
      '# Pending withdrawal  ',
      'Category: Withdrawals',
      'Tags: withdrawal, crypto',
      'Intents: withdrawal_pending, withdrawal help',
      'Shortcut: wd-pending',
      '',
      'Hi {{first_name | fallback: "there"}},',
      '',
      'Your withdrawal is being processed.',
      '',
      '----',
      '',
      'Bonus code',
      'Code: WELCOME is our welcome code.',
      '---',
      '---',
      '',
    ].join('\r\n');
    const preview = parseImport('text', text, NO_EXISTING);
    expect(preview.errors).toEqual([]);
    expect(preview.items).toEqual([
      item({
        title: 'Pending withdrawal',
        body: 'Hi {{user|there}},\n\nYour withdrawal is being processed.',
        category: 'Withdrawals',
        tags: ['withdrawal', 'crypto'],
        intents: ['withdrawal_pending', 'withdrawal_help'],
        shortcut: 'wd-pending',
      }),
      item({ title: 'Bonus code', body: 'Code: WELCOME is our welcome code.' }),
    ]);
  });

  it('starts blocks at "### " headings', () => {
    const text = [
      '### KYC level 2',
      'Folder: Verification',
      'Please upload a proof of address.',
      '',
      'Thanks!',
      '### Self-exclusion',
      'Intent: responsible_gambling',
      '',
      'We have received your request.',
    ].join('\n');
    const preview = parseImport('text', text, NO_EXISTING);
    expect(preview.errors).toEqual([]);
    expect(preview.items).toEqual([
      item({ title: 'KYC level 2', category: 'Verification', body: 'Please upload a proof of address.\n\nThanks!' }),
      item({ title: 'Self-exclusion', intents: ['responsible_gambling'], body: 'We have received your request.' }),
    ]);
  });

  it('reports blocks without a body and unknown intents', () => {
    const text = 'Title only\n---\nGood one\nIntents: deposit_missing, free money, casino_games\nBody text';
    const preview = parseImport('text', text, NO_EXISTING);
    expect(preview.items).toEqual([item({ title: 'Good one', intents: ['deposit_missing', 'casino_games'], body: 'Body text' })]);
    expect(preview.errors).toEqual(['Block 1: missing body', 'Block 2: unknown intent(s) dropped: "free money"']);
  });

  it('lists each unknown intent once and caps the list so one bad line cannot flood the preview', () => {
    const text = 'Title\nIntents: a, b, A, c, d, e, f, g, a, deposit_help\nBody';
    const preview = parseImport('text', text, NO_EXISTING);
    expect(preview.items[0]?.intents).toEqual(['deposit_help']);
    expect(preview.errors).toEqual(['Block 1: unknown intent(s) dropped: "a", "b", "c", "d", "e" and 2 more']);
  });

  it('reports empty content', () => {
    expect(parseImport('text', ' \n\r\n ', NO_EXISTING)).toEqual({ items: [], errors: ['Nothing to import: the content is empty.'] });
    expect(parseImport('text', '---\n---', NO_EXISTING).errors).toEqual(['No macros found in the content.']);
  });
});

// ---------------------------------------------------------------------------
// Duplicates and limits
// ---------------------------------------------------------------------------

describe('parseImport duplicates', () => {
  it('links existing macros by case/whitespace-insensitive title and reports repeats inside the file', () => {
    const existing = [
      { id: 'm1', title: 'Pending  Withdrawal' },
      { id: 'm2', title: 'Bonus' },
    ];
    const text = 'pending withdrawal \nBody 1\n---\n  PENDING\twithdrawal\nBody 2\n---\nNew one\nBody 3';
    const preview = parseImport('text', text, existing);
    expect(preview.items.map((i) => i.duplicateOf)).toEqual(['m1', 'm1', null]);
    expect(preview.errors).toEqual(['Block 2: same title as Block 1']);
  });
});

describe('parseImport limits', () => {
  it('rejects content above 2 MB', () => {
    const preview = parseImport('text', `Title\n${'x'.repeat(2 * 1024 * 1024)}`, NO_EXISTING);
    expect(preview.items).toEqual([]);
    expect(preview.errors).toHaveLength(1);
    expect(preview.errors[0]).toMatch(/too large .* maximum is 2 MB/);
  });

  it('rounds the reported size up so content just over the limit does not read as "2.0 MB"', () => {
    const preview = parseImport('text', 'x'.repeat(2 * 1024 * 1024 + 1), NO_EXISTING);
    expect(preview.errors).toEqual(['The content is too large (2.1 MB); the maximum is 2 MB. Split it into smaller files.']);
    expect(parseImport('text', `Title\n${'x'.repeat(2 * 1024 * 1024 - 6)}`, NO_EXISTING).errors[0]).not.toMatch(/too large/);
  });

  it('rejects more than 5000 macros', () => {
    const rows = Array.from({ length: 5001 }, (_, i) => `M${i},B`);
    const preview = parseImport('csv', `title,body\n${rows.join('\n')}`, NO_EXISTING);
    expect(preview.items).toEqual([]);
    expect(preview.errors).toEqual(['Too many macros (5001); import at most 5000 at a time by splitting the file.']);
  });

  it('accepts exactly 5000 macros', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `M${i},B`);
    const preview = parseImport('csv', `title,body\n${rows.join('\n')}`, NO_EXISTING);
    expect(preview.items).toHaveLength(5000);
    expect(preview.errors).toEqual([]);
  });

  it('skips items with over-long fields and trims over-long lists', () => {
    const json = JSON.stringify([
      { title: 'x'.repeat(201), body: 'b' },
      { title: 'Big body', body: 'b'.repeat(20_001) },
      { title: 'Many tags', body: 'b', tags: Array.from({ length: 45 }, (_, i) => `tag${i}`).concat('t'.repeat(61)) },
    ]);
    const preview = parseImport('json', json, NO_EXISTING);
    expect(preview.items.map((i) => i.title)).toEqual(['Many tags']);
    expect(preview.items[0]?.tags).toHaveLength(40);
    expect(preview.errors).toEqual([
      'Item 1: title is longer than 200 characters, skipped',
      'Item 2: body is longer than 20000 characters, skipped',
      'Item 3: 1 tags longer than 60 characters skipped',
      'Item 3: only the first 40 tags were kept',
    ]);
  });

  it('caps the number of reported problems', () => {
    const rows = Array.from({ length: 250 }, (_, i) => `M${i},`);
    const preview = parseImport('csv', `title,body\n${rows.join('\n')}`, NO_EXISTING);
    expect(preview.errors).toHaveLength(201);
    expect(preview.errors.at(-1)).toBe('...and 50 more problem(s) not shown.');
  });
});
