import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types.js';
import type { Analysis, Entity, EntityType, Fact, Intent, Macro, VerificationStatus } from '../../shared/types.js';
import {
  NON_ENGLISH_WARNING,
  RG_WARNING,
  checkGrounding,
  personalizeFast,
  personalizationWarnings,
  unansweredQuestions,
  variablesFromAnalysis,
} from './personalize.js';
import { APOLOGY_SENTENCES, CARE_SENTENCES } from './tone.js';

const SETTINGS = DEFAULT_SETTINGS.personalization;

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    intents: [{ intent: 'withdrawal_pending', score: 0.8 }],
    sentiment: 'neutral',
    sentimentScore: 0,
    urgency: 'normal',
    urgencyReasons: [],
    entities: [],
    questions: [],
    keywords: [],
    rgRisk: false,
    rgSignals: [],
    isLikelyNonEnglish: false,
    wordCount: 8,
    source: 'local',
    ...overrides,
  };
}

let offset = 0;
function entity(type: EntityType, value: string, raw = value): Entity {
  offset += 10;
  return { type, value, raw, start: offset, end: offset + raw.length };
}

function fact(id: string, value: string): Fact {
  return {
    id,
    macroId: 'm',
    key: `k.${id}`,
    statement: `Statement ${value}`,
    value,
    sourceUrl: null,
    evidenceQuote: null,
    status: 'verified',
    lastCheckedAt: null,
  };
}

function macro(title: string, body: string, intents: Intent[], extra: { verification?: VerificationStatus; facts?: Fact[] } = {}): Macro {
  return {
    id: title.toLowerCase().replace(/\W+/g, '-'),
    title,
    body,
    categoryId: null,
    tags: [],
    intents,
    triggers: [],
    notes: '',
    shortcut: '',
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    archivedAt: null,
    isFavorite: false,
    useCount: 0,
    lastUsedAt: null,
    verification: extra.verification ?? 'verified',
    facts: extra.facts ?? [],
  };
}

const WD = macro(
  'Crypto withdrawal pending',
  'Hi {{user}},\n\nYour {{amount}} {{currency}} withdrawal is being processed and should arrive within {{eta_time}}.\n\nLet me know if you have any other questions.',
  ['withdrawal_pending'],
  { facts: [fact('f-net', 'TRC20'), fact('f-eta', '24 hours'), fact('f-min', '20 USDT')] },
);
const KYC = macro('KYC Level 2', 'Hello {{user}},\n\nPlease complete Level 2 verification under Settings > Verify.', ['kyc_verification']);
const NO_GREETING = macro('Bonus info', 'The weekly bonus is posted every Saturday.', ['bonus_inquiry']);

describe('variablesFromAnalysis', () => {
  it('maps entities to standard variables', () => {
    const vars = variablesFromAnalysis(
      analysis({
        entities: [
          entity('name', 'Marko'),
          entity('username', 'marko99'),
          entity('email', 'marko@x.com'),
          entity('amount', '250'),
          entity('currency', 'USD'),
          entity('crypto', 'BTC'),
          entity('network', 'TRC20'),
          entity('tx_hash', '0xabc'),
          entity('bet_id', '12345'),
          entity('vip_rank', 'Platinum II'),
          entity('bonus_name', 'Weekly Bonus'),
          entity('document_type', 'passport'),
          entity('game', 'Plinko'),
          entity('provider', 'Pragmatic Play'),
        ],
      }),
    );
    expect(vars).toEqual({
      user: 'Marko',
      username: 'marko99',
      email: 'marko@x.com',
      amount: '250',
      currency: 'USD',
      crypto: 'BTC',
      network: 'TRC20',
      tx_hash: '0xabc',
      bet_id: '12345',
      vip_rank: 'Platinum II',
      bonus_name: 'Weekly Bonus',
      document_type: 'passport',
      game: 'Plinko',
      provider: 'Pragmatic Play',
    });
  });

  it('uses the crypto as currency when no fiat currency was found', () => {
    expect(variablesFromAnalysis(analysis({ entities: [entity('amount', '0.5'), entity('crypto', 'BTC')] }))).toEqual({
      amount: '0.5',
      crypto: 'BTC',
      currency: 'BTC',
    });
  });

  it('never fills policy values (eta_time, date, link, bonus_amount) from customer text', () => {
    const vars = variablesFromAnalysis(
      analysis({ entities: [entity('duration', '24 hours'), entity('date', '2026-10-08'), entity('url', 'https://x.com'), entity('phone', '+381 60 123')] }),
    );
    expect(vars).toEqual({});
  });

  it('first occurrence (by position) wins', () => {
    const later: Entity = { type: 'amount', value: '500', raw: '500', start: 50, end: 53 };
    const first: Entity = { type: 'amount', value: '100', raw: '100', start: 5, end: 8 };
    expect(variablesFromAnalysis(analysis({ entities: [later, first] })).amount).toBe('100');
  });

  it('capitalizes an all-lowercase name but keeps names that already have capitals', () => {
    expect(variablesFromAnalysis(analysis({ entities: [entity('name', "john o'brien")] })).user).toBe("John O'Brien");
    expect(variablesFromAnalysis(analysis({ entities: [entity('name', 'McKenzie')] })).user).toBe('McKenzie');
  });
});

describe('personalizeFast', () => {
  it('fills detected variables, keeps the macro greeting and reports mode/llm', () => {
    const res = personalizeFast({
      message: 'my 250 usdt withdrawal is stuck, Marko',
      macros: [WD],
      analysis: analysis({ entities: [entity('name', 'Marko'), entity('amount', '250'), entity('crypto', 'USDT')] }),
      settings: SETTINGS,
    });
    expect(res.text).toBe(
      'Hi Marko,\n\nYour 250 USDT withdrawal is being processed and should arrive within [ENTER ETA TIME].\n\nLet me know if you have any other questions.',
    );
    expect(res.mode).toBe('fast');
    expect(res.llm).toBeNull();
    expect(res.filledVariables).toEqual({ user: 'Marko', amount: '250', currency: 'USDT' });
    expect(res.placeholders).toEqual([{ label: '[ENTER ETA TIME]', variable: 'eta_time' }]);
    expect(res.guardrail).toEqual([{ kind: 'placeholder_left', text: '[ENTER ETA TIME]', detail: expect.any(String) }]);
    expect(res.warnings).toEqual([]);
  });

  it("falls back to 'there' for an unknown user", () => {
    const res = personalizeFast({ message: 'hi', macros: [KYC], analysis: analysis(), settings: SETTINGS });
    expect(res.text.startsWith('Hello there,\n\n')).toBe(true);
    expect(res.filledVariables).toEqual({});
    expect(res.placeholders).toEqual([]);
  });

  it('adds the configured greeting when the macro has none', () => {
    const res = personalizeFast({
      message: 'bonus?',
      macros: [NO_GREETING],
      analysis: analysis({ entities: [entity('name', 'Ana')] }),
      settings: { ...SETTINGS, greeting: 'Hey {{user}}!' },
    });
    expect(res.text).toBe('Hey Ana!\n\nThe weekly bonus is posted every Saturday.');
    expect(res.filledVariables).toEqual({ user: 'Ana' });
  });

  it('applies precedence: agent overrides > detected values > userFallback', () => {
    const detected = analysis({ entities: [entity('name', 'Marko'), entity('amount', '250'), entity('crypto', 'USDT')] });
    const res = personalizeFast({
      message: 'x',
      macros: [WD],
      analysis: detected,
      variables: { user: 'Marko Petrović', eta_time: '24 hours', amount: '  ' },
      settings: SETTINGS,
    });
    expect(res.text).toContain('Hi Marko Petrović,');
    expect(res.text).toContain('Your 250 USDT withdrawal');
    expect(res.text).toContain('within 24 hours.');
    expect(res.placeholders).toEqual([]);
    expect(res.guardrail).toEqual([]);
    expect(res.filledVariables).toEqual({ user: 'Marko Petrović', amount: '250', currency: 'USDT', eta_time: '24 hours' });
    expect(res.usedFactIds).toEqual(['f-eta']);
  });

  it('accepts override keys in any case', () => {
    const res = personalizeFast({ message: 'x', macros: [KYC], analysis: analysis(), variables: { USER: 'Ana' }, settings: SETTINGS });
    expect(res.text.startsWith('Hello Ana,')).toBe(true);
  });

  it('keeps an inline {{user|...}} fallback instead of the global fallback', () => {
    const m = macro('Dear', 'Dear {{user|valued player}},\n\nYour account is verified.', ['kyc_verification']);
    expect(personalizeFast({ message: 'x', macros: [m], analysis: analysis(), settings: SETTINGS }).text.startsWith('Dear valued player,')).toBe(true);
  });

  it('applies tone after the greeting when enabled, and not when disabled', () => {
    const angry = analysis({ sentiment: 'angry', keywords: ['scam'] });
    const toned = personalizeFast({ message: 'x', macros: [KYC], analysis: angry, settings: SETTINGS });
    const [, second] = toned.text.split('\n\n');
    expect(APOLOGY_SENTENCES.some((s) => second?.startsWith(s))).toBe(true);
    const plain = personalizeFast({ message: 'x', macros: [KYC], analysis: angry, settings: { ...SETTINGS, toneAdjust: false } });
    expect(plain.text).toBe('Hello there,\n\nPlease complete Level 2 verification under Settings > Verify.');
  });

  it('handles RG risk: caring tone and an RG warning', () => {
    const res = personalizeFast({
      message: 'I am addicted, please block me',
      macros: [KYC],
      analysis: analysis({ rgRisk: true, sentiment: 'positive', rgSignals: ['addicted'] }),
      settings: SETTINGS,
    });
    expect(CARE_SENTENCES.some((s) => res.text.includes(s))).toBe(true);
    expect(res.warnings).toEqual([RG_WARNING]);
  });

  it('combines several macros in the given order with one greeting', () => {
    const res = personalizeFast({
      message: 'withdrawal stuck and how do I verify?',
      macros: [WD, KYC],
      analysis: analysis({ entities: [entity('name', 'Ana')] }),
      variables: { eta_time: '24 hours', amount: '50', currency: 'LTC' },
      settings: SETTINGS,
    });
    expect(res.text).toBe(
      [
        'Hi Ana,',
        '',
        'Your 50 LTC withdrawal is being processed and should arrive within 24 hours.',
        '',
        'Regarding your question about KYC level 2:',
        'Please complete Level 2 verification under Settings > Verify.',
        '',
        'Let me know if you have any other questions.',
      ].join('\n'),
    );
  });

  it('lists questions whose intent no selected macro covers', () => {
    const res = personalizeFast({
      message: 'x',
      macros: [WD],
      analysis: analysis({
        questions: [
          { text: 'Where is my withdrawal?', intent: 'withdrawal_pending' },
          { text: 'How do I verify my account?', intent: 'kyc_verification' },
          { text: 'And something unclear', intent: null },
          { text: 'How do I verify my account?', intent: 'kyc_verification' },
        ],
      }),
      settings: SETTINGS,
    });
    expect(res.unansweredQuestions).toEqual(['How do I verify my account?']);
  });

  it('warns about non-English messages and outdated/conflicting macros', () => {
    const outdated = macro('Old limits', 'Limits are 10 BTC.', ['withdrawal_limits'], { verification: 'outdated' });
    const conflict = macro('Fees', 'No fees.', ['withdrawal_limits'], { verification: 'conflict' });
    const unverified = macro('Other', 'Other.', ['general'], { verification: 'unverified' });
    const res = personalizeFast({
      message: 'hola',
      macros: [outdated, conflict, unverified],
      analysis: analysis({ isLikelyNonEnglish: true }),
      settings: SETTINGS,
    });
    expect(res.warnings).toEqual([
      NON_ENGLISH_WARNING,
      "Macro 'Old limits' contains outdated or conflicting information - check the facts before sending.",
      "Macro 'Fees' contains outdated or conflicting information - check the facts before sending.",
    ]);
  });

  it('reports one guardrail issue per remaining placeholder, including literal ones', () => {
    const m = macro('Manual', 'Hi {{user}},\n\nYour case [ENTER CASE ID] for {{game}} and {{game}} is open.', ['casino_games']);
    const res = personalizeFast({ message: 'x', macros: [m], analysis: analysis(), settings: SETTINGS });
    expect(res.placeholders).toEqual([
      { label: '[ENTER CASE ID]', variable: null },
      { label: '[ENTER GAME]', variable: 'game' },
    ]);
    expect(res.guardrail.map((g) => [g.kind, g.text])).toEqual([
      ['placeholder_left', '[ENTER CASE ID]'],
      ['placeholder_left', '[ENTER GAME]'],
    ]);
  });

  it('reports used fact ids for fact values present in the text', () => {
    const res = personalizeFast({
      message: 'x',
      macros: [WD],
      analysis: analysis(),
      variables: { eta_time: '24  hours', currency: 'USDT', amount: '20' },
      settings: SETTINGS,
    });
    expect(res.usedFactIds).toEqual(['f-eta', 'f-min']);
  });

  it('is fast (well under the latency budget)', () => {
    const input = { message: 'x', macros: [WD, KYC, NO_GREETING], analysis: analysis({ sentiment: 'angry' as const }), settings: SETTINGS };
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) personalizeFast(input);
    expect((performance.now() - t0) / 100).toBeLessThan(5);
  });
});

describe('helpers', () => {
  it('unansweredQuestions ignores questions without intent', () => {
    expect(unansweredQuestions(analysis({ questions: [{ text: 'hmm?', intent: null }] }), [])).toEqual([]);
  });

  it('personalizationWarnings is empty for a clean message', () => {
    expect(personalizationWarnings(analysis(), [WD])).toEqual([]);
  });
});

interface SeedMacro {
  title: string;
  body: string;
  intents: Intent[];
  facts: { key: string; statement: string; value: string; sourceUrl: string | null }[];
}

describe('seed library regression', () => {
  const seed = JSON.parse(readFileSync(new URL('../../../seed/stake-demo-macros.json', import.meta.url), 'utf8')) as { macros: SeedMacro[] };
  const macros = seed.macros.map((m, i) =>
    macro(m.title, m.body, m.intents, {
      facts: m.facts.map((f, j) => ({ ...fact(`f${i}-${j}`, f.value), statement: f.statement, sourceUrl: f.sourceUrl })),
    }),
  );

  it('personalizes every seed macro and the grounding check finds nothing invented', () => {
    const detected = analysis({ sentiment: 'frustrated', entities: [entity('name', 'Ana'), entity('amount', '250'), entity('crypto', 'USDT')] });
    for (const m of macros) {
      const res = personalizeFast({ message: 'my 250 USDT is missing, Ana', macros: [m], analysis: detected, settings: SETTINGS });
      expect(res.text).toMatch(/^Hi Ana,\n/);
      expect(res.text).not.toMatch(/\{\{|\}\}/);
      const issues = checkGrounding(res.text, {
        macroBodies: [m.body],
        facts: m.facts,
        message: 'my 250 USDT is missing, Ana',
        variables: variablesFromAnalysis(detected),
      });
      expect(issues.filter((i) => i.kind !== 'placeholder_left'), m.title).toEqual([]);
    }
  });

  it('combines seed macros without flagging anything but placeholders', () => {
    for (let i = 0; i + 2 < macros.length; i += 3) {
      const trio = macros.slice(i, i + 3);
      const res = personalizeFast({ message: 'x', macros: trio, analysis: analysis(), settings: SETTINGS });
      expect(res.text.match(/^(?:Hi|Hello)\b/gm)).toHaveLength(1);
      const issues = checkGrounding(res.text, { macroBodies: trio.map((m) => m.body), facts: trio.flatMap((m) => m.facts), message: 'x', variables: {} });
      expect(issues.filter((issue) => issue.kind !== 'placeholder_left'), trio.map((m) => m.title).join(' + ')).toEqual([]);
    }
  });
});
