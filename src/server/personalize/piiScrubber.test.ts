import { describe, expect, it } from 'vitest';
import { findPii, ibanChecksumOk, luhnOk, type PiiKind } from './piiScrubber.js';

/** [kind, value] pairs found in `text`. */
function found(text: string): [PiiKind, string][] {
  return findPii(text).map((m) => [m.kind, m.value]);
}

describe('findPii: self-introduced names', () => {
  it.each([
    ["Hi, I'm Jovana Petrovic. My withdrawal has been pending for 3 days, where is it?", 'Jovana Petrovic'],
    ['I am Peter Parker, my deposit did not arrive.', 'Peter Parker'],
    ['hi im Marko and my deposit is gone', 'Marko'],
    ['Hi there, Ana Ivanovic here. My withdrawal is stuck.', 'Ana Ivanovic'],
    ["It's Ana here, my deposit is missing.", 'Ana'],
    ["It's Nikola Markovic, can't log in to my account", 'Nikola Markovic'],
    ['Hey Ana here', 'Ana'],
    ['Hello, this is Mr. John Smith.', 'John Smith'],
    ['Full name: Đorđe Petrović', 'Đorđe Petrović'],
    ['please call me Ana', 'Ana'],
  ])('%s', (text, name) => {
    expect(found(text)).toEqual([['NAME', name]]);
  });

  it('returns offsets into the text', () => {
    const text = 'Hello! I am Peter Parker.';
    const [m] = findPii(text);
    expect(text.slice(m!.start, m!.end)).toBe('Peter Parker');
  });

  it.each([
    "I'm waiting for 3 days, I am a VIP and I'm OK with that.",
    'I am Platinum IV and I am from Serbia. I am German.',
    "It's Monday. It's Bitcoin, not Ethereum. It's May already.",
    'I am Stake VIP, Gold level.',
    'This is Ridiculous! Withdrawal here, please help.',
    'Stake VIP here. BTC here.',
    "It's Sweet Bonanza that ate my money",
    'Game name: Sweet Bonanza. Bank name: Revolut',
    'I AM WAITING FOR MY MONEY',
    'Everything here is broken. Money here takes forever.',
  ])('ignores capitalized non-names: %s', (text) => {
    expect(found(text).filter(([kind]) => kind === 'NAME')).toEqual([]);
  });
});

describe('findPii: IBANs and payment cards', () => {
  it('finds checksum-valid IBANs, compact or grouped, and labeled ones in any case', () => {
    expect(found('send it to DE89370400440532013000 please')).toEqual([['IBAN', 'DE89370400440532013000']]);
    expect(found('IBAN: GB82 WEST 1234 5698 7654 32, thanks')).toEqual([['IBAN', 'GB82 WEST 1234 5698 7654 32']]);
    // Labeled: a typo (bad checksum) and lowercase are still masked; trailing words are not part of it.
    expect(found('my iban is de89 3704 0044 0532 0130 01 thanks')).toEqual([['IBAN', 'de89 3704 0044 0532 0130 01']]);
  });

  it('ignores IBAN-shaped values with a bad checksum and no IBAN label', () => {
    expect(found('code DE89370400440532013001 and TR12ABC')).toEqual([]);
    expect(ibanChecksumOk('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(ibanChecksumOk('DE89 3704 0044 0532 0130 01')).toBe(false);
  });

  it('finds Luhn-valid card numbers with spaces, dashes or none', () => {
    expect(found('card 4111 1111 1111 1111')).toEqual([['CARD', '4111 1111 1111 1111']]);
    expect(found('Mastercard 5555-5555-5555-4444, amex 3782 822463 10005')).toEqual([
      ['CARD', '5555-5555-5555-4444'],
      ['CARD', '3782 822463 10005'],
    ]);
    expect(found('card number 4012888888881881')).toEqual([['CARD', '4012888888881881']]);
  });

  it('ignores digit runs that are not card numbers', () => {
    expect(luhnOk('4111111111111111')).toBe(true);
    expect(luhnOk('4111111111111112')).toBe(false);
    // Luhn fails, all-same digits, first digit outside the card networks, amounts and decimals.
    expect(found('ids 4111 1111 1111 1112, 0000000000000000, 1234567812345670, 9999999999999995')).toEqual([]);
    expect(found('I deposited 1500.50 USDT and 2,500,000 coins, tx 0x3f9a8b7c6d5e4f3a2b1c3f9a8b7c6d5e4f3a2b1c')).toEqual([]);
  });
});

describe('findPii: dates of birth and document numbers', () => {
  it.each([
    ['I need to verify my account, my DOB is 14/03/1991.', '14/03/1991'],
    ['D.O.B.: 1991-03-14', '1991-03-14'],
    ['I was born on 14 March 1991', '14 March 1991'],
    ['date of birth March 14th, 1991', 'March 14th, 1991'],
    ['born in 1991', '1991'],
    ['14.03.1991 is my date of birth', '14.03.1991'],
  ])('%s', (text, dob) => {
    expect(found(text)).toEqual([['DOB', dob]]);
  });

  it('leaves other dates alone', () => {
    expect(found('I deposited on 14/03/2025 and withdrew on March 20, 2025')).toEqual([]);
  });

  it.each([
    ['For KYC: passport no. X1234567', 'X1234567'],
    ['passport number: AB1234567', 'AB1234567'],
    ['my ID number is 12345678', '12345678'],
    ['Document number 9876-5432-10', '9876-5432-10'],
    ["driver's license no. D1234567", 'D1234567'],
    ['SSN 123-45-6789', '123-45-6789'],
  ])('%s', (text, id) => {
    expect(found(text)).toEqual([['DOC_ID', id]]);
  });

  it('ignores document words without a number and bet/transaction ids', () => {
    expect(found('my passport is expired, my ID card is valid')).toEqual([]);
    expect(found('bet id no 12345678, transaction number 87654321')).toEqual([]);
  });
});

describe('findPii: street addresses and phones', () => {
  it.each([
    ['For KYC: my address is 221B Baker Street, London NW1 6XE and passport', '221B Baker Street, London NW1 6XE'],
    ['I live at 12 baker street', '12 baker street'],
    ['Address: 5 Old Kent Road, London.', '5 Old Kent Road, London'],
    ['I sent 2 BTC to 221B Baker Street', '221B Baker Street'],
    ['1600 Pennsylvania Ave, Washington 20500', '1600 Pennsylvania Ave, Washington 20500'],
    ['Hauptstraße 5, 10115 Berlin', 'Hauptstraße 5, 10115 Berlin'],
    ['Bulevar kralja Aleksandra 73', 'Bulevar kralja Aleksandra 73'],
  ])('%s', (text, address) => {
    expect(found(text).filter(([kind]) => kind === 'ADDRESS')).toEqual([['ADDRESS', address]]);
  });

  it('ignores numbers followed by ordinary words', () => {
    expect(found('I played 5 rounds on the street. I sent 100 to Dr Smith. 3 days, 2 bets on Main St')).toEqual([]);
  });

  it('finds international and labeled phone numbers only', () => {
    expect(found('Call me on +44 7700 900123 or whatsapp 0612345678')).toEqual([
      ['PHONE', '+44 7700 900123'],
      ['PHONE', '0612345678'],
    ]);
    expect(found('My bet 1234567890 and order number 55512345678 lost')).toEqual([]);
  });
});

describe('findPii', () => {
  it('returns non-overlapping matches sorted by position, the most specific kind first', () => {
    const text = 'Hi, I am Peter Parker. IBAN DE89370400440532013000, card 4111 1111 1111 1111, phone +44 7700 900123';
    expect(found(text)).toEqual([
      ['NAME', 'Peter Parker'],
      ['IBAN', 'DE89370400440532013000'],
      ['CARD', '4111 1111 1111 1111'],
      ['PHONE', '+44 7700 900123'],
    ]);
    // A card number after a phone keyword is a card, not a phone.
    expect(found('call me, card 4111 1111 1111 1111')).toEqual([['CARD', '4111 1111 1111 1111']]);
  });

  it('finds nothing in empty or ordinary support messages', () => {
    expect(findPii('')).toEqual([]);
    expect(findPii('   ')).toEqual([]);
    expect(found('My BTC withdrawal of 0.05 BTC has been pending for 2 days, where is it? Bet id 445566. VIP Platinum IV.')).toEqual([]);
  });
});
