import { describe, expect, it } from 'vitest';
import { ensureGreeting, splitGreeting, startsWithGreeting, withUserFallback } from './greeting.js';

describe('startsWithGreeting', () => {
  it.each([
    'Hi John,',
    'hello there',
    'HEY!',
    'Dear customer,',
    'Good morning John,',
    'good  afternoon,',
    'Good evening',
    'Greetings,',
    '\n\n  Hi {{user}},\n\nBody',
  ])('detects %j', (text) => {
    expect(startsWithGreeting(text)).toBe(true);
  });

  it.each(['History of your bets', 'Thank you for contacting us', 'Your withdrawal, hi', 'Hiya', 'Good luck', ''])(
    'does not detect %j',
    (text) => {
      expect(startsWithGreeting(text)).toBe(false);
    },
  );
});

describe('splitGreeting', () => {
  it('keeps a greeting line as a unit and reports the blank-line separator', () => {
    expect(splitGreeting('Hi John,\n\nYour withdrawal is pending.\nMore.')).toEqual({
      greeting: 'Hi John,',
      separator: '\n\n',
      rest: 'Your withdrawal is pending.\nMore.',
    });
  });

  it('reports a single newline separator', () => {
    expect(splitGreeting('Hello!\nBody')).toEqual({ greeting: 'Hello!', separator: '\n', rest: 'Body' });
  });

  it('splits an inline greeting after the comma', () => {
    expect(splitGreeting('Hi John, your withdrawal is pending.\n\nMore.')).toEqual({
      greeting: 'Hi John,',
      separator: ' ',
      rest: 'your withdrawal is pending.\n\nMore.',
    });
  });

  it('splits a longer greeting line at its first clause end instead of swallowing the content', () => {
    expect(splitGreeting('Hello {{user}} and thank you for contacting Stake about the bonus, it is sent every Saturday.')).toEqual({
      greeting: 'Hello {{user}} and thank you for contacting Stake about the bonus,',
      separator: ' ',
      rest: 'it is sent every Saturday.',
    });
    expect(splitGreeting('Hi John. Your withdrawal is pending.')).toEqual({ greeting: 'Hi John.', separator: ' ', rest: 'Your withdrawal is pending.' });
    expect(splitGreeting('Dear Mr. Smith, your account is verified.')).toEqual({
      greeting: 'Dear Mr. Smith,',
      separator: ' ',
      rest: 'your account is verified.',
    });
  });

  it('handles a greeting-only text and leading blank lines', () => {
    expect(splitGreeting('\n\nHi there,')).toEqual({ greeting: 'Hi there,', separator: '\n', rest: '' });
  });

  it('returns null without a greeting', () => {
    expect(splitGreeting('Your withdrawal is pending.')).toBeNull();
  });
});

describe('withUserFallback', () => {
  it('replaces a bare {{user}} only when the user is unknown', () => {
    expect(withUserFallback('Hi {{ User }}, {{user}}', {}, 'there')).toBe('Hi there, there');
    expect(withUserFallback('Hi {{user}},', { user: 'Marko' }, 'there')).toBe('Hi {{user}},');
    expect(withUserFallback('Hi {{user}},', { USER: 'Marko' }, 'there')).toBe('Hi {{user}},');
  });

  it('keeps inline fallbacks and ignores an empty fallback setting', () => {
    expect(withUserFallback('Dear {{user|valued customer}},', {}, 'there')).toBe('Dear {{user|valued customer}},');
    expect(withUserFallback('Hi {{user}},', {}, '  ')).toBe('Hi {{user}},');
  });

  it('does not interpret $ patterns in the fallback', () => {
    expect(withUserFallback('Hi {{user}},', {}, '$& friend')).toBe('Hi $& friend,');
  });
});

describe('ensureGreeting', () => {
  it('keeps an existing greeting untouched', () => {
    const text = 'Hello Marko,\n\nYour deposit arrived.';
    expect(ensureGreeting(text, 'Hi {{user}},', { user: 'Ana' }, 'there')).toBe(text);
  });

  it('prepends the rendered greeting on its own line', () => {
    expect(ensureGreeting('Your deposit arrived.', 'Hi {{user}},', { user: 'Ana' }, 'there')).toBe('Hi Ana,\n\nYour deposit arrived.');
  });

  it("falls back to 'there' when the user is unknown", () => {
    expect(ensureGreeting('Your deposit arrived.', 'Hi {{user}},', {}, 'there')).toBe('Hi there,\n\nYour deposit arrived.');
    expect(ensureGreeting('Body', 'Hi {{user}},', { user: '   ' }, 'there')).toBe('Hi there,\n\nBody');
  });

  it('uses a placeholder when neither a user nor a fallback exists', () => {
    expect(ensureGreeting('Body', 'Hi {{user}},', {}, '')).toBe('Hi [ENTER USER],\n\nBody');
  });

  it('renders other variables of the greeting template', () => {
    expect(ensureGreeting('Body', 'Hi {{user}} ({{vip_rank}}),', { user: 'Ana', vip_rank: 'Gold' }, 'there')).toBe('Hi Ana (Gold),\n\nBody');
  });

  it('drops leading whitespace of the body and handles an empty body', () => {
    expect(ensureGreeting('\n\n  Body', 'Hi {{user}},', {}, 'there')).toBe('Hi there,\n\nBody');
    expect(ensureGreeting('', 'Hi {{user}},', {}, 'there')).toBe('Hi there,');
  });

  it('leaves the text unchanged when the greeting template is empty', () => {
    expect(ensureGreeting('Body', '  ', {}, 'there')).toBe('Body');
  });
});
