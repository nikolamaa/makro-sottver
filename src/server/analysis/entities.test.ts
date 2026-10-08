import { describe, expect, it } from 'vitest';
import type { Entity, EntityType } from '../../shared/types.js';
import { durationHours, extractEntities, normalizeNumber } from './entities.js';

const TX = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060';
const BARE_TX = 'a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d';
const ETH = '0x52908400098527886E0F7030069857D2E4169EE7';
const BECH32 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const LEGACY = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const TRON = 'TXLAW5wQ1fBvG5Yp3Q7cRyLRfz2nNk5RBn';
const SOL = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';

function pairs(text: string, ...types: EntityType[]): [EntityType, string][] {
  return extractEntities(text)
    .filter((e) => !types.length || types.includes(e.type))
    .map((e) => [e.type, e.value]);
}

function values(text: string, type: EntityType): string[] {
  return extractEntities(text)
    .filter((e) => e.type === type)
    .map((e) => e.value);
}

function expectWellFormed(text: string, entities: Entity[]): void {
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;
    expect(e.raw).toBe(text.slice(e.start, e.end));
    if (i > 0) expect(e.start).toBeGreaterThanOrEqual(entities[i - 1]!.end);
  }
}

describe('extractEntities: hashes and addresses', () => {
  it('extracts tx hashes (0x and bare 64 hex) instead of phones or bet ids', () => {
    const text = `Deposit tx hash: ${TX} and the BTC txid ${BARE_TX}`;
    expect(pairs(text, 'tx_hash', 'phone', 'bet_id')).toEqual([
      ['tx_hash', TX],
      ['tx_hash', BARE_TX],
    ]);
  });

  it('extracts ETH, BTC (bech32 + legacy) and TRON addresses', () => {
    const text = `Send to ${ETH} or ${BECH32} or ${LEGACY}, tron: ${TRON}`;
    expect(values(text, 'crypto_address')).toEqual([ETH, BECH32, LEGACY, TRON]);
  });

  it('extracts a Solana address only next to address/wallet wording', () => {
    expect(values(`my solana wallet address is ${SOL}`, 'crypto_address')).toEqual([SOL]);
    expect(values(`reference ${SOL}`, 'crypto_address')).toEqual([]);
  });
});

describe('extractEntities: money', () => {
  it.each([
    ['I deposited $250', [['currency', 'USD'], ['amount', '250']]],
    ['withdrew 250 USDT', [['amount', '250'], ['crypto', 'USDT']]],
    ['sent 0.05 BTC', [['amount', '0.05'], ['crypto', 'BTC']]],
    ['a 1,000.50 EUR deposit', [['amount', '1000.50'], ['currency', 'EUR']]],
    ['I lost €50 and then 50€', [['currency', 'EUR'], ['amount', '50'], ['amount', '50'], ['currency', 'EUR']]],
    ['deposit of 2.5k usdt', [['amount', '2500'], ['crypto', 'USDT']]],
    ['R$ 300 via pix', [['currency', 'BRL'], ['amount', '300']]],
    ['USDT 1,250 pending', [['crypto', 'USDT'], ['amount', '1250']]],
    ['I deposited 500 and it is gone', [['amount', '500']]],
  ] as const)('%s', (text, expected) => {
    expect(pairs(text, 'amount', 'currency', 'crypto')).toEqual(expected);
  });

  it('extracts standalone currency and crypto mentions', () => {
    expect(pairs('do you support CAD and bitcoin cash?', 'currency', 'crypto')).toEqual([
      ['currency', 'CAD'],
      ['crypto', 'BCH'],
    ]);
  });

  it('avoids false positives on normal words (try, link, uni, ada, solution)', () => {
    const text = 'I will try again later, send me the link, my uni friend Ada found a solution';
    expect(pairs(text, 'currency', 'crypto', 'amount')).toEqual([]);
  });

  it('accepts ambiguous tickers next to an amount or in obvious currency context', () => {
    expect(pairs('I sent 100 TRY and 50 link, also some UNI tokens', 'currency', 'crypto')).toEqual([
      ['currency', 'TRY'],
      ['crypto', 'LINK'],
      ['crypto', 'UNI'],
    ]);
    expect(pairs('can I deposit in PHP?', 'currency')).toEqual([['currency', 'PHP']]);
  });

  it('extracts networks, preferring the network reading of "on Solana"', () => {
    expect(pairs('USDT TRC20, not ERC-20 or bsc', 'network')).toEqual([
      ['network', 'TRC20'],
      ['network', 'ERC20'],
      ['network', 'BEP20'],
    ]);
    expect(pairs('I sent USDC on Solana', 'crypto', 'network')).toEqual([
      ['crypto', 'USDC'],
      ['network', 'Solana'],
    ]);
    expect(pairs('I want to buy solana', 'crypto', 'network')).toEqual([['crypto', 'SOL']]);
    expect(pairs('USDT on Tron network', 'crypto', 'network')).toEqual([
      ['crypto', 'USDT'],
      ['network', 'TRC20'],
    ]);
  });
});

describe('extractEntities: Stake vocabulary', () => {
  it('extracts VIP ranks in display form', () => {
    expect(values('I am Platinum IV, my friend is diamond 3 and I was gold before reaching that rank', 'vip_rank')).toEqual([
      'Platinum IV',
      'Diamond III',
      'Gold',
    ]);
    expect(values('Obsidian I. Next is Opal', 'vip_rank')).toEqual(['Obsidian I', 'Opal']);
    expect(values('i found gold coins in the game', 'vip_rank')).toEqual([]);
    expect(values('I am Diamond I think', 'vip_rank')).toEqual(['Diamond']);
    expect(values('Gold coins dropped in the slot', 'vip_rank')).toEqual([]);
  });

  it('extracts bonus names', () => {
    const text = 'weekly bonus, Reload, rake back, monthly bonus, pre-monthly, birthday bonus, a bonus drop and the welcome offer';
    expect(values(text, 'bonus_name')).toEqual([
      'Weekly Bonus',
      'Reload',
      'Rakeback',
      'Monthly Bonus',
      'Pre-Monthly Bonus',
      'Birthday Bonus',
      'Bonus Drop',
      'Welcome Offer',
    ]);
    expect(values('I tried to reload the page', 'bonus_name')).toEqual([]);
  });

  it('extracts document types', () => {
    const text = "I sent my passport, driver's licence, ID card, a utility bill, bank statement, selfie and proof of address";
    expect(values(text, 'document_type')).toEqual([
      'passport',
      "driver's license",
      'ID card',
      'utility bill',
      'bank statement',
      'selfie',
      'proof of address',
    ]);
  });

  it('extracts games and providers, ambiguous game names only in context', () => {
    expect(pairs('Gates of Olympus by Pragmatic Play froze, then Evolution live blackjack', 'game', 'provider')).toEqual([
      ['game', 'Gates of Olympus'],
      ['provider', 'Pragmatic Play'],
      ['provider', 'Evolution'],
      ['game', 'Blackjack'],
    ]);
    expect(values('I was playing mines and Plinko on Hacksaw', 'game')).toEqual(['Mines', 'Plinko']);
    expect(values('my withdrawal is in limbo, in some cases the site will crash', 'game')).toEqual([]);
    expect(values('Cases like this happen. Is the Crash game down?', 'game')).toEqual(['Crash']);
  });
});

describe('extractEntities: ids, time and contact data', () => {
  it('extracts bet ids', () => {
    expect(values('Bet ID: casino:123456789012, also sport:98765432 and ticket 1234567890', 'bet_id')).toEqual([
      'casino:123456789012',
      'sport:98765432',
      '1234567890',
    ]);
    expect(values('my bet id 123456789 was voided', 'bet_id')).toEqual(['123456789']);
    expect(values('I placed 3 bets of 1234 each', 'bet_id')).toEqual([]);
  });

  it('extracts and normalizes durations', () => {
    expect(values("It's been 48 hours, 3 days, 2 weeks, 30 mins, 48h and a few days", 'duration')).toEqual([
      '48 hours',
      '3 days',
      '2 weeks',
      '30 minutes',
      '48 hours',
      'few days',
    ]);
  });

  it('extracts dates', () => {
    expect(values('on 2026-10-05, 05/10/2026, Oct 5th, 12 March 2026, yesterday and last Monday', 'date')).toEqual([
      '2026-10-05',
      '05/10/2026',
      'Oct 5th',
      '12 March 2026',
      'yesterday',
      'last Monday',
    ]);
  });

  it('extracts phones only in international format or with phone context', () => {
    expect(values('call me on +44 7700 900123', 'phone')).toEqual(['+447700900123']);
    expect(values('my phone number is 0612345678', 'phone')).toEqual(['0612345678']);
    expect(values('bet id 123456789', 'phone')).toEqual([]);
    expect(values('I won 12345678 coins', 'phone')).toEqual([]);
  });

  it('extracts emails and urls without overlap', () => {
    expect(pairs('mail John.Smith@Gmail.com or see https://stake.com/settings?ref=a@b.co.', 'email', 'url')).toEqual([
      ['email', 'john.smith@gmail.com'],
      ['url', 'https://stake.com/settings?ref=a@b.co'],
    ]);
    expect(pairs('check help.stake.com/en for details', 'url')).toEqual([['url', 'help.stake.com/en']]);
  });

  it('extracts usernames only from explicit wording or handle-like tokens', () => {
    expect(values('my username is jsmith_99', 'username')).toEqual(['jsmith_99']);
    expect(values('Username: CryptoKing', 'username')).toEqual(['CryptoKing']);
    expect(values('user name @lucky_player', 'username')).toEqual(['lucky_player']);
    expect(values('my account john_doe is locked', 'username')).toEqual(['john_doe']);
    expect(values('my account is locked', 'username')).toEqual([]);
    expect(values('I forgot my username and password', 'username')).toEqual([]);
  });

  it('extracts names from introductions and sign-offs only', () => {
    expect(values('Hi, my name is John and my deposit is missing', 'name')).toEqual(['John']);
    expect(values('This is Ana here, quick question', 'name')).toEqual(['Ana']);
    expect(values('deposit missing. Thanks, John', 'name')).toEqual(['John']);
    expect(values('Please help.\nRegards,\nJohn Smith', 'name')).toEqual(['John Smith']);
    expect(values('Thanks in advance, Mike', 'name')).toEqual(['Mike']);
    expect(values('Thanks, Waiting', 'name')).toEqual([]);
    expect(values('Thanks for your help', 'name')).toEqual([]);
    expect(values('my name is john', 'name')).toEqual([]);
    expect(values('Thanks Here', 'name')).toEqual([]);
  });
});

describe('extractEntities: invariants', () => {
  it('returns sorted, non-overlapping entities whose raw matches the text', () => {
    const text = `Hi, I'm Platinum IV. I deposited 1,000 USDT (TRC20) to ${TRON} 3 days ago, tx ${TX}. Bet ID casino:123456789012. Email a.b@example.com. Thanks, John`;
    const entities = extractEntities(text);
    expectWellFormed(text, entities);
    expect(entities.map((e) => e.type)).toEqual([
      'vip_rank',
      'amount',
      'crypto',
      'network',
      'crypto_address',
      'duration',
      'tx_hash',
      'bet_id',
      'email',
      'name',
    ]);
  });

  it('returns nothing for empty, emoji-only or plain chatter', () => {
    expect(extractEntities('')).toEqual([]);
    expect(extractEntities('🙂🙂')).toEqual([]);
    expect(extractEntities('hello, can you help me please')).toEqual([]);
  });
});

describe('normalizeNumber / durationHours', () => {
  it.each([
    ['1,000.50', '1000.50'],
    ['1.000,50', '1000.50'],
    ['0,05', '0.05'],
    ['1,000', '1000'],
    ['1.000.000', '1000000'],
    ['0.05', '0.05'],
    ['2.5k', '2500'],
    ['250', '250'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeNumber(raw)).toBe(expected);
  });

  it('converts durations to hours', () => {
    expect(durationHours('3 days')).toBe(72);
    expect(durationHours('48 hours')).toBe(48);
    expect(durationHours('2 weeks')).toBe(336);
    expect(durationHours('30 minutes')).toBe(0.5);
    expect(durationHours('few days')).toBe(72);
    expect(durationHours('soon')).toBeNull();
  });
});
