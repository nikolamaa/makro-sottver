import { describe, expect, it } from 'vitest';
import { combineBodies, splitClosing, titleTopic } from './combine.js';

const WITHDRAWAL = {
  title: 'Withdrawal pending',
  body: 'Hi {{user}},\n\nYour withdrawal of {{amount}} {{currency}} is pending review.\n\nLet me know if you have any other questions. Have a great day!',
};
const KYC = {
  title: 'KYC Level 2 verification',
  body: 'Hello {{user}},\n\nThank you for contacting us.\nPlease complete Level 2 verification under Settings > Verify.\n\nIf you have any further questions, feel free to reach out!',
};
const BONUS = { title: '[BONUS] Weekly Bonus', body: 'Hi {{user}}, the weekly bonus is posted every Saturday.' };

describe('combineBodies', () => {
  it('returns a single body unchanged (trimmed, normalized newlines)', () => {
    expect(combineBodies([{ title: 'A', body: '  Hi {{user}},\r\n\r\nBody.\r\nLet me know!  ' }])).toBe('Hi {{user}},\n\nBody.\nLet me know!');
    expect(combineBodies([])).toBe('');
  });

  it('combines two macros: one greeting, bridge, only the last closing', () => {
    expect(combineBodies([WITHDRAWAL, KYC])).toBe(
      [
        'Hi {{user}},',
        '',
        'Your withdrawal of {{amount}} {{currency}} is pending review.',
        '',
        'Regarding your question about KYC level 2 verification:',
        'Please complete Level 2 verification under Settings > Verify.',
        '',
        'If you have any further questions, feel free to reach out!',
      ].join('\n'),
    );
  });

  it('combines three macros in the given order with bridges for parts 2..n', () => {
    const text = combineBodies([KYC, BONUS, WITHDRAWAL]);
    expect(text.match(/\b(?:Hi|Hello)\b/g)).toEqual(['Hello']);
    expect(text.indexOf('Level 2')).toBeLessThan(text.indexOf('weekly bonus'));
    expect(text.indexOf('weekly bonus')).toBeLessThan(text.indexOf('withdrawal of'));
    expect(text).toContain('Regarding your question about weekly bonus:\nThe weekly bonus is posted every Saturday.');
    expect(text).toContain('Regarding your question about withdrawal pending:\nYour withdrawal of');
    // KYC's closing is dropped, the withdrawal closing (last part) is kept once at the very end.
    expect(text).not.toContain('feel free');
    expect(text.endsWith('Let me know if you have any other questions. Have a great day!')).toBe(true);
    expect(text.match(/Have a great day/g)).toHaveLength(1);
  });

  it('keeps the latest closing at the end when the last part has none', () => {
    const text = combineBodies([WITHDRAWAL, BONUS]);
    expect(text.endsWith('Regarding your question about weekly bonus:\nThe weekly bonus is posted every Saturday.\n\nLet me know if you have any other questions. Have a great day!')).toBe(true);
  });

  it('deduplicates identical closings across parts', () => {
    const closing = 'Let me know if you need anything else.';
    const text = combineBodies([
      { title: 'A', body: `Hi {{user}},\n\nFirst answer.\n\n${closing}` },
      { title: 'B', body: `Second answer.\n\n${closing}` },
    ]);
    expect(text.split(closing)).toHaveLength(2);
    expect(text.endsWith(closing)).toBe(true);
  });

  it('removes sign-off + name lines from earlier parts', () => {
    const text = combineBodies([
      { title: 'A', body: 'Hi {{user}},\n\nFirst answer.\n\nKind regards,\nStake Support' },
      { title: 'B', body: 'Second answer.\n\nBest regards,\nStake Support' },
    ]);
    expect(text).toBe('Hi {{user}},\n\nFirst answer.\n\nRegarding your question about b:\nSecond answer.\n\nBest regards,\nStake Support');
  });

  it("drops the generic opener ('Thank you for contacting us.') of later parts only", () => {
    const text = combineBodies([
      { title: 'A', body: 'Hi {{user}},\n\nThank you for contacting us. First answer.' },
      { title: 'B', body: 'Hi {{user}},\n\nThank you for reaching out to Stake! Second answer.' },
    ]);
    expect(text).toBe('Hi {{user}},\n\nThank you for contacting us. First answer.\n\nRegarding your question about b:\nSecond answer.');
  });

  it('does not strip a long opener sentence that carries content', () => {
    const body = 'Thank you for reaching out regarding your deposit, it has been credited to your balance.';
    expect(combineBodies([{ title: 'A', body: 'Hi,\n\nA.' }, { title: 'Deposit', body }])).toContain(body);
  });

  it('strips an inline greeting from a later part and capitalizes the rest', () => {
    expect(combineBodies([{ title: 'A', body: 'Hi {{user}},\n\nA.' }, BONUS])).toBe(
      'Hi {{user}},\n\nA.\n\nRegarding your question about weekly bonus:\nThe weekly bonus is posted every Saturday.',
    );
  });

  it('drops lines that an earlier part already said (shared disclaimers), but not list steps', () => {
    const disclaimer = 'Please never share your password with anyone.';
    const text = combineBodies([
      { title: 'A', body: `Hi {{user}},\n\n1. Go to Settings > Security now\nFirst answer.\n${disclaimer}` },
      { title: 'B', body: `1. Go to Settings > Security now\nSecond answer.\n${disclaimer}` },
    ]);
    expect(text.split(disclaimer)).toHaveLength(2);
    expect(text.split('1. Go to Settings > Security now')).toHaveLength(3);
  });

  it('skips parts that are empty or become empty', () => {
    expect(combineBodies([{ title: 'A', body: 'Hi {{user}},\n\nA.' }, { title: 'Empty', body: '  ' }])).toBe('Hi {{user}},\n\nA.');
    expect(combineBodies([{ title: 'A', body: 'Hi {{user}},\n\nA.' }, { title: 'Greeting only', body: 'Hello {{user}},' }])).toBe('Hi {{user}},\n\nA.');
  });

  it("keeps an earlier part's final request instead of dropping it as a closing", () => {
    const text = combineBodies([
      { title: 'Deposit missing', body: 'Hi {{user}},\n\nWe are checking your deposit.\nPlease let us know your TXID so we can trace it.' },
      { title: 'Bonus', body: 'The weekly bonus is posted every Saturday.\n\nLet me know if you have any other questions!' },
    ]);
    expect(text).toBe(
      'Hi {{user}},\n\nWe are checking your deposit.\nPlease let us know your TXID so we can trace it.\n\n' +
        'Regarding your question about bonus:\nThe weekly bonus is posted every Saturday.\n\nLet me know if you have any other questions!',
    );
  });

  it("strips only the greeting of a later part, never the content on the greeting's line", () => {
    const first = { title: 'A', body: 'Hi {{user}},\n\nA body.' };
    expect(
      combineBodies([first, { title: 'Bonus', body: 'Hello {{user}} and thank you for contacting Stake about the bonus, it is sent every Saturday.' }]),
    ).toBe('Hi {{user}},\n\nA body.\n\nRegarding your question about bonus:\nIt is sent every Saturday.');
    expect(combineBodies([first, { title: 'WD', body: 'Hi {{user}}. Your withdrawal is pending review.\nMore info.' }])).toBe(
      'Hi {{user}},\n\nA body.\n\nRegarding your question about WD:\nYour withdrawal is pending review.\nMore info.',
    );
  });

  it('uses a generic bridge for an empty title', () => {
    expect(combineBodies([{ title: 'A', body: 'A.' }, { title: ' [X] ', body: 'B.' }])).toBe('A.\n\nRegarding your other question:\nB.');
  });
});

describe('splitClosing', () => {
  it('splits trailing closing sentences off the last line only', () => {
    expect(splitClosing('Answer one. Let me know if you need anything else.')).toEqual({
      body: 'Answer one.',
      closing: 'Let me know if you need anything else.',
    });
  });

  it('removes multiple closing lines and an emoji tail', () => {
    expect(splitClosing('Answer.\n\nIs there anything else I can help with?\nHave a lovely evening! 😊')).toEqual({
      body: 'Answer.',
      closing: 'Is there anything else I can help with?\nHave a lovely evening! 😊',
    });
  });

  it.each([
    'Feel free to reach out anytime.',
    "Please don't hesitate to contact us.",
    'If you have any more questions, just ask.',
    'If you have any questions, we are here.',
    'Should you need anything else, we are here 24/7.',
    'I hope this helps!',
    'Cheers!',
    'Thanks!',
    'Best regards,',
    'Have a nice weekend.',
    'Good luck!',
  ])('recognizes %j as a closing', (line) => {
    expect(splitClosing(`Answer.\n${line}`)).toEqual({ body: 'Answer.', closing: line });
  });

  it('does not treat content sentences as closings', () => {
    const body = "If you feel you'd like to take a break from playing, just let me know and I'll walk you through the options.";
    expect(splitClosing(body)).toEqual({ body, closing: '' });
    expect(splitClosing('Thanks for your deposit, it was credited.')).toEqual({ body: 'Thanks for your deposit, it was credited.', closing: '' });
  });

  it.each([
    'Please let us know your transaction hash so we can check it.',
    'Let us know the network you used.',
    'Let us know if the deposit is still missing after 1 hour.',
    'Let us know which game you were playing.',
    'If you need any documents, upload them under Settings > Verify.',
    'If you need help with your deposit, open the Wallet.',
    'If you have any issues logging in, clear your cache.',
    'Should you need to change your email, go to Settings.',
    'Feel free to use any supported network.',
    "Don't hesitate to enable 2FA for extra security.",
    'If you have any questions about wagering, see https://help.stake.com/en/articles/4929043.',
    'Let us know if you need {{document_type}}.',
  ])('keeps the request/content line %j (never a closing)', (line) => {
    expect(splitClosing(`Answer.\n${line}`)).toEqual({ body: `Answer.\n${line}`, closing: '' });
  });

  it('never cuts a list step, even one that reads like a closing', () => {
    for (const body of ['Steps:\n1. Open the wallet\n2. Copy the TXID\n3. Let us know the TXID.', 'Options:\n- Feel free to contact us.']) {
      expect(splitClosing(body)).toEqual({ body, closing: '' });
    }
  });

  it.each([
    'Just let us know.',
    'Let me know!',
    "Let us know if there's anything else we can do.",
    'Let me know if we can help with anything else!',
    'Do let us know if you require any additional information.',
    'If you need any further assistance, feel free to contact us.',
    'If you need help, just ask.',
    'In case you need anything else, just write to us.',
    'Let me know how it goes.',
    'Don’t hesitate to contact us.',
    'If there’s anything else, let us know.',
    'Let me know if you have any other questions, {{user}}!',
  ])('recognizes the generic closing %j', (line) => {
    expect(splitClosing(`Answer.\n${line}`)).toEqual({ body: 'Answer.', closing: line });
  });

  it('removes a sign-off followed by two name lines, and patience + understanding', () => {
    expect(splitClosing('Answer.\n\nBest regards,\nAna\nStake Support')).toEqual({ body: 'Answer.', closing: 'Best regards,\nAna\nStake Support' });
    expect(splitClosing('Answer.\nThanks for your patience and understanding.')).toEqual({
      body: 'Answer.',
      closing: 'Thanks for your patience and understanding.',
    });
  });

  it("treats 'Thank you for your patience' as a closing only as the whole final line", () => {
    expect(splitClosing('Answer.\nThank you for your patience.')).toEqual({ body: 'Answer.', closing: 'Thank you for your patience.' });
    const opening = 'Thank you for your patience. Your withdrawal is now approved.';
    expect(splitClosing(opening)).toEqual({ body: opening, closing: '' });
    const midText = 'Thank you for your patience while we review your documents.';
    expect(splitClosing(midText)).toEqual({ body: midText, closing: '' });
  });
});

describe('titleTopic', () => {
  it('lowercases words but keeps acronyms, drops [tags] and edge punctuation', () => {
    expect(titleTopic('Withdrawal Limits')).toBe('withdrawal limits');
    expect(titleTopic('[WD] KYC Level 2 - ')).toBe('KYC level 2');
    expect(titleTopic('Lost access to 2FA (BTC):')).toBe('lost access to 2FA (BTC)');
    expect(titleTopic('VIP Program')).toBe('VIP program');
  });
});
