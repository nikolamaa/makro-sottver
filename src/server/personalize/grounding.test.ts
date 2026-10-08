import { describe, expect, it } from 'vitest';
import type { GuardrailKind } from '../../shared/types.js';
import { type GroundingSources, checkGrounding, normalizeUrl } from './grounding.js';

const MACRO =
  'Hi {{user}},\n\nCrypto withdrawals are usually processed within {{eta_time|24 hours}} once there are 3 confirmations. ' +
  'The minimum withdrawal is $20 (or 20 USDT) and there is no fee. Rakeback is 5% of the house edge.\n' +
  'Steps:\n1. Open the wallet\n2. Click Withdraw\n' +
  'More info: https://help.stake.com/en/articles/5222675-withdrawals?utm_source=x#top';

function sources(overrides: Partial<GroundingSources> = {}): GroundingSources {
  return {
    macroBodies: [MACRO],
    facts: [
      {
        statement: 'Bank transfers take 3-5 business days.',
        value: '3-5 business days',
        sourceUrl: 'https://help.stake.com/en/articles/9000001-bank-transfers',
      },
      { statement: 'Withdrawals above 1,000 USD require Level 3 verification.', value: '1,000 USD', sourceUrl: null },
    ],
    message: 'Hi, I withdrew 250 USDT on 2026-10-07 at 14:30 (bet id 99887766) and it is still pending after 6 hours!',
    variables: { user: 'Marko', amount: '250', currency: 'USDT' },
    ...overrides,
  };
}

function kinds(reply: string, src = sources()): [GuardrailKind, string][] {
  return checkGrounding(reply, src).map((i) => [i.kind, i.text]);
}

describe('checkGrounding - numbers', () => {
  it('accepts a reply that only uses numbers from the macro, facts, message and variables', () => {
    const reply =
      'Hi Marko,\n\nI can see your 250 USDT withdrawal from 2026-10-07 at 14:30 (bet 99887766). It has been pending for 6 hours; ' +
      'withdrawals are usually processed within 24 hours after 3 confirmations. The minimum is $20 and there is no fee, ' +
      'rakeback is 5%. Bank transfers take 3-5 business days and amounts above 1,000 USD need Level 3.';
    expect(checkGrounding(reply, sources())).toEqual([]);
  });

  it('flags an invented duration, percentage, amount and count', () => {
    const reply = 'Your withdrawal will arrive within 48 hours, the fee is 2%, you will get $100 back and need 6 confirmations.';
    expect(kinds(reply)).toEqual([
      ['unsupported_number', '48 hours'],
      ['unsupported_number', '2%'],
      ['unsupported_number', '$100'],
      ['unsupported_number', '6 confirmations'],
    ]);
  });

  it("flags '24 hours' when no source mentions it", () => {
    const src = sources({ macroBodies: ['Hi {{user}}, your withdrawal is pending review.'] });
    expect(kinds('Your withdrawal will be processed within 24 hours.', src)).toEqual([['unsupported_number', '24 hours']]);
  });

  it('normalizes duration spellings: 24h ~ 24 hrs ~ 24 hours ~ twenty-four hours', () => {
    for (const reply of ['Within 24h.', 'Within 24 hrs.', 'Within 24 hours.', 'Within twenty-four hours.', 'Within a 24-hour window.']) {
      expect(kinds(reply)).toEqual([]);
    }
  });

  it('normalizes number words one..twelve', () => {
    const src = sources({ macroBodies: ['Codes expire after 2 hours and payouts take three days.'] });
    expect(kinds('Codes expire after two hours. Payouts take 3 days.', src)).toEqual([]);
    expect(kinds('Codes expire after five hours.', src)).toEqual([['unsupported_number', 'five hours']]);
  });

  it('normalizes thousand separators and currency forms: $100 ~ 100 USD ~ 100 dollars', () => {
    const src = sources({ macroBodies: ['The cap is $1,000 per day and the bonus is 100 USD.'], message: '', variables: {} });
    expect(kinds('The cap is 1000 USD per day and the bonus is $100.', src)).toEqual([]);
    expect(kinds('The bonus is 100 dollars.', src)).toEqual([]);
    expect(kinds('The bonus is 100 EUR.', src)).toEqual([['unsupported_number', '100 EUR']]);
  });

  it('accepts ranges written differently and range end points', () => {
    expect(kinds('Bank transfers take 3 to 5 days.')).toEqual([]);
    expect(kinds('Bank transfers take between 3 and 5 business days.')).toEqual([]);
    expect(kinds('Bank transfers take 2-4 days.')).toEqual([['unsupported_number', '2-4 days']]);
  });

  it('accepts an amount whose number and currency both come from the customer/agent', () => {
    const src = sources({ message: 'I deposited 250 yesterday', variables: { currency: 'USDT' }, macroBodies: ['Deposits need confirmations.'] });
    expect(kinds('Your 250 USDT deposit is on its way.', src)).toEqual([]);
  });

  it('flags an invented amount stitched from an unrelated macro number and currency', () => {
    // "$" comes from "$10" and "100" from "100 free spins": neither makes "$100" a sourced amount.
    const src = sources({ macroBodies: ['Minimum deposit is $10. You get 100 free spins.'], message: 'Where is my bonus?', variables: {} });
    expect(kinds('We added a $100 bonus to your account.', src)).toEqual([['unsupported_number', '$100']]);
    // The AI guessing the currency of the customer's bare number is flagged too.
    const guessed = sources({ macroBodies: ['We support USDT on TRC20.'], message: 'I deposited 250 yesterday', variables: {} });
    expect(kinds('Your 250 USDT deposit is on its way.', guessed)).toEqual([['unsupported_number', '250 USDT']]);
  });

  it('checks values rendered from macro variables', () => {
    const src = sources({ macroBodies: ['It will arrive within {{eta_time}} hours.'], variables: { eta_time: '12' } });
    expect(kinds('It will arrive within 12 hours.', src)).toEqual([]);
  });

  it('flags bare numbers with 2+ digits but ignores single digits, list markers, placeholders and tokens', () => {
    const reply = 'Step 2 is easy.\n1. Open the wallet\n10. Done\nPlease send [ENTER AMOUNT 50] to ⟦NAME_12⟧. Ticket 31337 is closed.';
    expect(kinds(reply)).toEqual([
      ['unsupported_number', '31337'],
      ['placeholder_left', '[ENTER AMOUNT 50]'],
      ['placeholder_left', '⟦NAME_12⟧'],
    ]);
  });

  it('ignores numbers inside identifiers, hashes, versions and URLs', () => {
    const reply = 'Enable 2FA, check tx 0x3fa9b2c4d5 and app v2.5, see https://help.stake.com/en/articles/5222675-withdrawals.';
    expect(kinds(reply)).toEqual([]);
  });

  it('flags years and dates unless they are in the sources', () => {
    expect(kinds('This policy changed in 2024.')).toEqual([['unsupported_number', '2024']]);
    expect(kinds('This policy changed in 2026.')).toEqual([]);
    expect(kinds('It was sent on 2026-10-09.')).toEqual([['unsupported_number', '2026-10-09']]);
    expect(kinds('It was sent on 2026-10-07 at 14:30.')).toEqual([]);
    expect(kinds('Try again at 16:00.')).toEqual([['unsupported_number', '16:00']]);
  });

  it('handles k suffixes and ordinals', () => {
    const src = sources({ macroBodies: ['VIP hosts help players who wagered $10,000 by the 15th of the month.'] });
    expect(kinds('Players who wagered $10k get a host by the 15th.', src)).toEqual([]);
    expect(kinds('Hosts reply by the 20th.', src)).toEqual([['unsupported_number', '20th']]);
  });

  it('treats ambiguous currency words as plain words unless capitalized', () => {
    const src = sources({ macroBodies: ['Up to 25 attempts.'], message: '', variables: {} });
    expect(kinds('You have 25 try left.', src)).toEqual([]);
    expect(kinds('You received 25 TRY.', src)).toEqual([['unsupported_number', '25 TRY']]);
  });
});

describe('checkGrounding - urls', () => {
  it('accepts the same URL ignoring scheme, www, query, fragment and trailing slash', () => {
    for (const url of [
      'https://help.stake.com/en/articles/5222675-withdrawals',
      'http://help.stake.com/en/articles/5222675-withdrawals/',
      'https://www.help.stake.com/en/articles/5222675-withdrawals?lang=en#steps',
      'help.stake.com/en/articles/5222675-withdrawals',
    ]) {
      expect(kinds(`Read ${url}.`)).toEqual([]);
    }
  });

  it('accepts a parent path of a source URL on the same full host', () => {
    expect(kinds('Visit https://help.stake.com/en for more.')).toEqual([]);
    expect(kinds('Visit help.stake.com for more.')).toEqual([]);
  });

  it('flags new URLs, deeper paths and other hostnames', () => {
    expect(kinds('See https://help.stake.com/en/articles/1234567-made-up.')).toEqual([
      ['unsupported_url', 'https://help.stake.com/en/articles/1234567-made-up'],
    ]);
    expect(kinds('Use our mirror stake.bet or https://stake-bonus.com/claim')).toEqual([
      ['unsupported_url', 'stake.bet'],
      ['unsupported_url', 'https://stake-bonus.com/claim'],
    ]);
    expect(kinds('Go to stake.com/settings')).toEqual([['unsupported_url', 'stake.com/settings']]);
  });

  it('checks email addresses', () => {
    const src = sources({ macroBodies: ['Email recovery@stake.com from your account address.'], message: 'my mail is Ana.B@mail.com' });
    expect(kinds('Please email recovery@stake.com from ana.b@mail.com.', src)).toEqual([]);
    expect(kinds('Please email vip@stake.com.', src)).toEqual([['unsupported_url', 'vip@stake.com']]);
  });

  it('normalizeUrl strips scheme, www, query, fragment, trailing slash and punctuation', () => {
    expect(normalizeUrl('HTTPS://www.Stake.com/Settings/?tab=security#x).')).toBe('stake.com/settings');
  });
});

describe('checkGrounding - promises', () => {
  it.each([
    ['We guarantee your withdrawal today.', 'guarantee'],
    ['It will definitely arrive.', 'will definitely'],
    ['I promise it will be fine.', 'I promise'],
    ['I am 100% sure.', '100%'],
    ['Your funds will be credited today.', 'will be credited today'],
    ['We will refund you the full amount.', 'will refund you'],
    ['Your balance will be refunded.', 'will be refunded'],
    ['Rest assured, it is safe.', 'Rest assured'],
  ])('flags %j', (reply, fragment) => {
    expect(kinds(reply)).toEqual([['promise', fragment]]);
  });

  it('does not flag promise wording that the sources already use', () => {
    const src = sources({ macroBodies: ['Provably fair games guarantee every result can be verified. Failed deposits will be refunded automatically.'] });
    expect(kinds('Our provably fair games guarantee verifiable results. A failed deposit will be refunded automatically.', src)).toEqual([]);
  });

  it("never lets the customer's own words license a promise", () => {
    const src = sources({ message: 'Can you guarantee I get it today? Is it 100% safe? Will you refund you me?' });
    expect(kinds('I guarantee you will get it today, it is 100% safe and we will refund you.', src)).toEqual([
      ['promise', 'guarantee'],
      ['promise', '100%'],
      ['promise', 'will refund you'],
    ]);
  });

  it('does not flag negated promise phrases', () => {
    for (const reply of [
      "We can't guarantee a specific time.",
      'There is no guarantee of an exact arrival time.',
      'We cannot promise that, sorry.',
      "I'm not 100% sure yet, so I asked the team.",
      "Unfortunately we won't be able to refund you.",
      'We are not able to compensate you for market changes.',
    ]) {
      expect(kinds(reply), reply).toEqual([]);
    }
    expect(kinds('Not sure why, but we guarantee it.')).toEqual([['promise', 'guarantee']]);
    // The 40-char look-back window starts inside "casino": its "no" tail must not count as a negation.
    const cut = `Our casino ${'x'.repeat(36)} guarantee`;
    expect(cut.indexOf('guarantee') - 'Our casi'.length).toBe(40);
    expect(kinds(cut)).toEqual([['promise', 'guarantee']]);
  });

  it('a negated phrase in the macro does not license the affirmed promise', () => {
    const src = sources({ macroBodies: ['We cannot guarantee exact arrival times.'] });
    expect(kinds('We cannot guarantee exact arrival times.', src)).toEqual([]);
    expect(kinds('We guarantee it arrives today.', src)).toEqual([['promise', 'guarantee']]);
  });

  it('reports 100% only once (as a promise, not also as a number)', () => {
    expect(kinds('It is 100% safe.')).toEqual([['promise', '100%']]);
  });
});

describe('checkGrounding - placeholders and details', () => {
  it('flags each remaining placeholder once with a short detail', () => {
    const issues = checkGrounding('Hi [ENTER USER], ETA is [ENTER ETA TIME] ([ENTER ETA TIME]).', sources());
    expect(issues).toEqual([
      { kind: 'placeholder_left', text: '[ENTER USER]', detail: expect.stringMatching(/fill in/i) },
      { kind: 'placeholder_left', text: '[ENTER ETA TIME]', detail: expect.stringMatching(/fill in/i) },
    ]);
  });

  it('de-duplicates repeated issues', () => {
    expect(kinds('Within 48 hours. Yes, 48 hours.')).toEqual([['unsupported_number', '48 hours']]);
  });

  it('works with empty sources', () => {
    expect(kinds('Hello there.', { macroBodies: [], facts: [], message: '', variables: {} })).toEqual([]);
  });

  it('is fast on a long reply', () => {
    const reply = 'Within 24 hours you get 20 USDT, see https://help.stake.com/en. '.repeat(200);
    const t0 = performance.now();
    checkGrounding(reply, sources());
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
