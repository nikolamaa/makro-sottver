import { describe, expect, it } from 'vitest';
import type { Entity, EntityType } from '../../shared/types.js';
import { applyPseudonyms, pseudonymize, restorePseudonyms } from './pseudonymize.js';

/** Build entities from the raw values as they appear in `text` (first occurrence offsets). */
function entities(text: string, items: [EntityType, string, string?][]): Entity[] {
  return items.map(([type, raw, value]) => {
    const start = text.indexOf(raw);
    return { type, raw, value: value ?? raw, start, end: start + raw.length };
  });
}

describe('pseudonymize', () => {
  const message =
    'Hi, I am John Smith (username johnny_99, john.smith@mail.com). Tx 0xabc123def456 to bc1qxyz789 for bet 445566. ' +
    'Call +44 7700 900123. John Smith again: I sent 250 USDT.';
  const found = entities(message, [
    ['name', 'John Smith'],
    ['username', 'johnny_99'],
    ['email', 'john.smith@mail.com'],
    ['tx_hash', '0xabc123def456'],
    ['crypto_address', 'bc1qxyz789'],
    ['bet_id', '445566'],
    ['phone', '+44 7700 900123'],
    ['amount', '250'],
    ['currency', 'USDT'],
  ]);

  it('replaces personal data with typed tokens and keeps amounts/currencies', () => {
    const { text, mapping } = pseudonymize(message, found);
    expect(text).toBe(
      'Hi, I am ⟦NAME_1⟧ (username ⟦USERNAME_1⟧, ⟦EMAIL_1⟧). Tx ⟦TX_HASH_1⟧ to ⟦ADDRESS_1⟧ for bet ⟦BET_ID_1⟧. ' +
        'Call ⟦PHONE_1⟧. ⟦NAME_1⟧ again: I sent 250 USDT.',
    );
    expect(mapping).toEqual({
      '⟦NAME_1⟧': 'John Smith',
      '⟦USERNAME_1⟧': 'johnny_99',
      '⟦EMAIL_1⟧': 'john.smith@mail.com',
      '⟦TX_HASH_1⟧': '0xabc123def456',
      '⟦ADDRESS_1⟧': 'bc1qxyz789',
      '⟦BET_ID_1⟧': '445566',
      '⟦PHONE_1⟧': '+44 7700 900123',
    });
  });

  it('round-trips exactly', () => {
    const { text, mapping } = pseudonymize(message, found);
    expect(restorePseudonyms(text, mapping)).toBe(message);
  });

  it('gives the same value the same token and numbers distinct values per type', () => {
    const text = 'Ana wrote to Marko. Ana and Marko both play. Ana@x.io';
    const { text: out, mapping } = pseudonymize(text, entities(text, [['name', 'Ana'], ['name', 'Marko'], ['name', 'Ana'], ['email', 'Ana@x.io']]));
    expect(out).toBe('⟦NAME_1⟧ wrote to ⟦NAME_2⟧. ⟦NAME_1⟧ and ⟦NAME_2⟧ both play. ⟦EMAIL_1⟧');
    expect(mapping).toEqual({ '⟦NAME_1⟧': 'Ana', '⟦NAME_2⟧': 'Marko', '⟦EMAIL_1⟧': 'Ana@x.io' });
  });

  it('replaces the longest value first when values overlap', () => {
    const text = 'John and John Smith and JohnS99';
    const { text: out, mapping } = pseudonymize(text, entities(text, [['name', 'John'], ['name', 'John Smith']]), { username: 'JohnS99' });
    expect(out).toBe('⟦NAME_1⟧ and ⟦NAME_2⟧ and ⟦USERNAME_1⟧');
    expect(restorePseudonyms(out, mapping)).toBe(text);
  });

  it('never corrupts already inserted tokens', () => {
    const text = 'User NAME wrote, NAME_1 too';
    const { text: out, mapping } = pseudonymize(text, [], { username: 'NAME', user: 'NAME_1' });
    expect(out).toBe('User ⟦USERNAME_1⟧ wrote, ⟦NAME_1⟧ too');
    expect(restorePseudonyms(out, mapping)).toBe(text);
  });

  it('matches whole words only and case-sensitively', () => {
    const text = 'Ann read the Announcement; ann is lowercase.';
    expect(pseudonymize(text, [], { user: 'Ann' }).text).toBe('⟦NAME_1⟧ read the Announcement; ann is lowercase.');
  });

  it('maps knownValues user/email/username (>= 2 chars) even when they are not in the text', () => {
    const { text, mapping } = pseudonymize('Where is my money?', [], {
      user: 'Marko',
      email: 'marko@x.com',
      username: 'mk',
      amount: '250',
      currency: 'USDT',
      eta_time: '24 hours',
      bet_id: ' ',
    });
    expect(text).toBe('Where is my money?');
    expect(mapping).toEqual({ '⟦NAME_1⟧': 'Marko', '⟦EMAIL_1⟧': 'marko@x.com', '⟦USERNAME_1⟧': 'mk' });
  });

  it('ignores values shorter than 2 characters', () => {
    expect(pseudonymize('I am X', [], { user: 'X' })).toEqual({ text: 'I am X', mapping: {} });
  });

  it('shares a token between an entity and an identical known value', () => {
    const text = 'I am Marko';
    const { mapping } = pseudonymize(text, entities(text, [['name', 'Marko']]), { user: 'Marko' });
    expect(mapping).toEqual({ '⟦NAME_1⟧': 'Marko' });
  });

  it('uses the raw text of an entity and also replaces its normalized value', () => {
    const text = 'Mail JOHN@X.COM or john@x.com';
    const { text: out, mapping } = pseudonymize(text, entities(text, [['email', 'JOHN@X.COM', 'john@x.com']]));
    expect(out).toBe('Mail ⟦EMAIL_1⟧ or ⟦EMAIL_1⟧');
    expect(mapping).toEqual({ '⟦EMAIL_1⟧': 'JOHN@X.COM' });
  });
});

describe('pseudonymize with the built-in PII scrubber', () => {
  it('tokenizes personal data the analyzer entities miss and restores it exactly', () => {
    const text =
      "Hi, I'm Jovana Petrovic. DOB 14/03/1991, passport no. X1234567, IBAN DE89370400440532013000, " +
      'card 4111 1111 1111 1111, address 221B Baker Street, London NW1 6XE, phone +44 7700 900123. ' +
      'Jovana Petrovic again: I sent 250 USDT.';
    const { text: out, mapping } = pseudonymize(text, entities(text, [['amount', '250'], ['currency', 'USDT']]));
    expect(out).toBe(
      "Hi, I'm ⟦NAME_1⟧. DOB ⟦DOB_1⟧, passport no. ⟦DOC_ID_1⟧, IBAN ⟦IBAN_1⟧, card ⟦CARD_1⟧, address ⟦ADDRESS_1⟧, " +
        'phone ⟦PHONE_1⟧. ⟦NAME_1⟧ again: I sent 250 USDT.',
    );
    expect(mapping).toEqual({
      '⟦NAME_1⟧': 'Jovana Petrovic',
      '⟦DOB_1⟧': '14/03/1991',
      '⟦DOC_ID_1⟧': 'X1234567',
      '⟦IBAN_1⟧': 'DE89370400440532013000',
      '⟦CARD_1⟧': '4111 1111 1111 1111',
      '⟦ADDRESS_1⟧': '221B Baker Street, London NW1 6XE',
      '⟦PHONE_1⟧': '+44 7700 900123',
    });
    expect(restorePseudonyms(out, mapping)).toBe(text);
    expect(restorePseudonyms('Thanks [[NAME_1]], we checked [DOC_ID_1] and ⟦ address_1 ⟧', mapping)).toBe(
      'Thanks Jovana Petrovic, we checked X1234567 and 221B Baker Street, London NW1 6XE',
    );
  });

  it('numbers scrubber findings together with the entities of the same type, in order of appearance', () => {
    const text = 'My name is Marko. I am Peter Parker. Wallet bc1qxyz789, home 12 Baker Street.';
    const { text: out, mapping } = pseudonymize(text, entities(text, [['name', 'Marko'], ['crypto_address', 'bc1qxyz789']]));
    expect(out).toBe('My name is ⟦NAME_1⟧. I am ⟦NAME_2⟧. Wallet ⟦ADDRESS_1⟧, home ⟦ADDRESS_2⟧.');
    expect(mapping['⟦NAME_2⟧']).toBe('Peter Parker');
    expect(mapping['⟦ADDRESS_2⟧']).toBe('12 Baker Street');
    expect(restorePseudonyms(out, mapping)).toBe(text);
  });

  it('keeps analyzer entities as they are, except that a card number beats a phone entity', () => {
    const text = 'Bet id 4111111111111111 lost. My number is 4012 8888 8888 1881.';
    const found = entities(text, [
      ['bet_id', '4111111111111111'],
      ['phone', '4012 8888 8888 1881', '4012888888881881'],
    ]);
    const { text: out, mapping } = pseudonymize(text, found);
    expect(out).toBe('Bet id ⟦BET_ID_1⟧ lost. My number is ⟦CARD_1⟧.');
    expect(mapping).toEqual({ '⟦BET_ID_1⟧': '4111111111111111', '⟦CARD_1⟧': '4012 8888 8888 1881' });
  });

  it('keeps a card-like number the analyzer read as an amount', () => {
    const text = 'I deposited 4222222222222 USDT yesterday.';
    expect(pseudonymize(text, entities(text, [['amount', '4222222222222'], ['currency', 'USDT']]))).toEqual({ text, mapping: {} });
    // Without the amount entity it is a (Luhn-valid) card number.
    expect(pseudonymize(text, []).text).toBe('I deposited ⟦CARD_1⟧ USDT yesterday.');
  });

  it('uses the longer value when the scrubber extends an analyzer name', () => {
    const text = 'I am Peter Parker, Peter for short.';
    const { text: out, mapping } = pseudonymize(text, entities(text, [['name', 'Peter']]));
    expect(out).toBe('I am ⟦NAME_1⟧, ⟦NAME_2⟧ for short.');
    expect(mapping).toEqual({ '⟦NAME_1⟧': 'Peter Parker', '⟦NAME_2⟧': 'Peter' });
    expect(restorePseudonyms(out, mapping)).toBe(text);
  });

  it('adds what the scrubber finds in extra texts to the mapping, for applyPseudonyms', () => {
    const { text, mapping } = pseudonymize('Where is my money?', [], { user: 'Ana' }, ['refund to card 4111 1111 1111 1111', '24 hours']);
    expect(text).toBe('Where is my money?');
    expect(mapping).toEqual({ '⟦NAME_1⟧': 'Ana', '⟦CARD_1⟧': '4111 1111 1111 1111' });
    expect(applyPseudonyms('refund to card 4111 1111 1111 1111', mapping)).toBe('refund to card ⟦CARD_1⟧');
  });

  it('leaves amounts, tx hashes, bet ids and ordinary capitalized words alone', () => {
    const text = 'I am Waiting since Monday for 0.05 BTC (tx 0xabc123def456), bet 445566. It is Stake VIP here. 3 days!';
    expect(pseudonymize(text, [])).toEqual({ text, mapping: {} });
  });
});

describe('applyPseudonyms', () => {
  it('tokenizes another text with an existing mapping', () => {
    const { mapping } = pseudonymize('I am Marko', [], { user: 'Marko', email: 'marko@x.com' });
    expect(applyPseudonyms('Hi Marko, we wrote to marko@x.com', mapping)).toBe('Hi ⟦NAME_1⟧, we wrote to ⟦EMAIL_1⟧');
    expect(applyPseudonyms('', mapping)).toBe('');
    expect(applyPseudonyms('Hi Marko', {})).toBe('Hi Marko');
  });
});

describe('restorePseudonyms', () => {
  const mapping = { '⟦NAME_1⟧': 'Marko', '⟦TX_HASH_1⟧': '0xabc' };

  it('restores tokens, including ASCII bracket variants an LLM may write', () => {
    expect(restorePseudonyms('Hi ⟦NAME_1⟧, [[NAME_1]], [NAME_1], ⟦ name_1 ⟧, [[TX_HASH_1]]', mapping)).toBe('Hi Marko, Marko, Marko, Marko, 0xabc');
  });

  it('leaves unknown tokens and placeholders untouched', () => {
    expect(restorePseudonyms('⟦NAME_2⟧ [[EMAIL_1]] [ENTER ETA TIME] [NAME_9]', mapping)).toBe('⟦NAME_2⟧ [[EMAIL_1]] [ENTER ETA TIME] [NAME_9]');
  });
});
