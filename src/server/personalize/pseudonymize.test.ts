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
