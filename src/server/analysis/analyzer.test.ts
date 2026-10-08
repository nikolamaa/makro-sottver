import { describe, expect, it } from 'vitest';
import type { Intent } from '../../shared/types.js';
import {
  analyzeMessage,
  detectRgRisk,
  detectSentiment,
  detectUrgency,
  extractEntities,
  extractKeywords,
  isLikelyNonEnglish,
  scoreIntents,
  splitQuestions,
} from './analyzer.js';

const TX = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060';

/** [customer message, expected top intent, other intents that must also be present] */
const INTENT_CASES: [string, Intent, Intent[]?][] = [
  ['my btc withdrawal is pending for 2 days', 'withdrawal_pending'],
  ["Where is my withdrawal?? It's been 3 days", 'withdrawal_pending'],
  ['I requested a cashout of 500 USDT 6 hours ago and it still says processing', 'withdrawal_pending'],
  ['how do I withdraw to my Binance wallet?', 'withdrawal_help'],
  ['Can I cash out to a different crypto than the one I deposited?', 'withdrawal_help'],
  ['what is the minimum withdrawal for LTC?', 'withdrawal_limits'],
  ['Is there a daily withdrawal limit? I want to cash out 50k', 'withdrawal_limits'],
  ["I deposited 0.01 BTC two hours ago and it's not in my balance", 'deposit_missing'],
  [`Deposit not credited, here is the txid ${TX}`, 'deposit_missing'],
  ['I sent USDT on the wrong network (BEP20 instead of ERC20), can you recover it?', 'deposit_missing'],
  ['I sent 0.05 BTC to my deposit address but my balance is still 0', 'deposit_missing'],
  ['How can I deposit with ETH?', 'deposit_help'],
  ["what's the minimum deposit for dogecoin", 'deposit_help'],
  ['Can I buy crypto with my Visa card?', 'payment_methods'],
  ['Do you accept bank transfer in INR or UPI?', 'payment_methods'],
  ['Which currencies can I use? Can I change my display currency to EUR?', 'payment_methods'],
  ['When will I get my weekly bonus?', 'bonus_inquiry'],
  ["I didn't receive my monthly bonus this month", 'bonus_inquiry'],
  ['how does rakeback work and where do I claim it?', 'bonus_inquiry'],
  ['Is there a welcome offer for new players?', 'bonus_inquiry'],
  ['I got a bonus drop code from Twitter but it says invalid', 'bonus_inquiry'],
  ['How much do I have to wager before I can withdraw the bonus?', 'wagering_requirement', ['bonus_inquiry']],
  ['what is the rollover on the reload?', 'wagering_requirement', ['bonus_inquiry']],
  ['How do I level up to Platinum? Who is my VIP host?', 'vip_program'],
  ["I'm Gold now but my VIP progress hasn't moved in a week", 'vip_program'],
  ['My KYC level 2 documents were rejected, why?', 'kyc_verification'],
  ['What documents do I need for proof of address?', 'kyc_verification'],
  ["I want to withdraw but it says I need to complete level 3 verification first", 'kyc_verification', ['withdrawal_help']],
  ["I can't log in, forgot my password and the reset email never arrives", 'account_access'],
  ['I lost my phone with Google Authenticator, how do I reset 2FA?', 'account_access'],
  ['how do i turn on 2fa on my account', 'account_security'],
  ['got an email from stake-rewards-team.net saying i need to verify my wallet within 24h or lose my balance. is this legit??', 'account_security'],
  ['Someone logged into my account and withdrew everything, I think I was hacked', 'account_security'],
  ['I got a suspicious email asking for my password, is it really from Stake?', 'account_security'],
  ['Please close my account permanently', 'account_closure'],
  ["I want to close my account, I have a gambling problem and can't stop gambling", 'responsible_gambling', ['account_closure']],
  ['Can you set a deposit limit of $500 per week on my account?', 'responsible_gambling'],
  ['I need a break, please self-exclude me for 6 months', 'responsible_gambling'],
  ['My parlay was settled as lost but all legs won', 'sports_betting'],
  ['Why was my bet on the Lakers voided? The NBA game finished normally', 'sports_betting'],
  ['The Crash game froze mid round and I lost my bet', 'technical_issue', ['casino_games']],
  ['Is Plinko provably fair? How do I verify the server seed?', 'casino_games'],
  ['Why is my max bet limited on sports?', 'betting_limits', ['sports_betting']],
  ['the site is not loading, just a black screen on chrome', 'technical_issue'],
  ['Payments are temporarily unavailable when I try to deposit', 'technical_issue'],
  ['How does the affiliate program work, how much commission do I get from referrals?', 'affiliate'],
  ['i signed up through my buddys link but also typed a promo code in the box, which one counts now?', 'affiliate'],
  ['the cashout button on my parlay is gone now that the game started, why can I not cash out?', 'sports_betting'],
  ['hi, sent 120 xrp but forgot to add the memo tag. can you help get it back?', 'deposit_missing'],
  ['i want my account DELETED with all my data, not closed, deleted', 'account_closure'],
  ['can i block only the casino part for a month but keep sports?', 'responsible_gambling'],
  ['my wifi cut out while i had free spins going on a bgaming game, are they lost?', 'technical_issue'],
  ["whats the minimum bet on plinko?", 'betting_limits'],
  ['I want to file a formal complaint about your support', 'complaint'],
  ["My deposit hasn't arrived, this is a scam, you are thieves!!!", 'deposit_missing', ['complaint']],
  ['Hey, I made a deposit of 100 dollars with Moonpay 30 min ago but nothing showed up in my wallet', 'deposit_missing'],
  ['hi i put 50 on a multi bet and one leg was void but it says lost', 'sports_betting'],
  ['my account john_doe is locked', 'account_access'],
  ['Hello, are you there?', 'general'],
  ['Thank you so much for your help!', 'general'],
];

function intentsOf(text: string): Intent[] {
  return scoreIntents(text).map((s) => s.intent);
}

describe('scoreIntents', () => {
  it.each(INTENT_CASES)('%s -> %s', (text, top, also = []) => {
    const intents = intentsOf(text);
    expect(intents[0]).toBe(top);
    for (const intent of also) expect(intents).toContain(intent);
  });

  it('covers every intent in the taxonomy', () => {
    const covered = new Set(INTENT_CASES.map(([, top]) => top));
    expect(covered.size).toBe(21);
  });

  it('returns at most 3 intents with scores in 0.15..1, sorted desc', () => {
    for (const [text] of INTENT_CASES) {
      const scores = scoreIntents(text);
      expect(scores.length).toBeGreaterThan(0);
      expect(scores.length).toBeLessThanOrEqual(3);
      for (const s of scores) {
        expect(s.score).toBeGreaterThanOrEqual(0.15);
        expect(s.score).toBeLessThanOrEqual(1);
      }
      expect([...scores].sort((a, b) => b.score - a.score)).toEqual(scores);
    }
  });

  it('falls back to general (0.3) without evidence and returns [] for empty text', () => {
    expect(scoreIntents('hmm ok')).toEqual([{ intent: 'general', score: 0.3 }]);
    expect(scoreIntents('🙂')).toEqual([{ intent: 'general', score: 0.3 }]);
    expect(scoreIntents('   ')).toEqual([]);
  });

  it('uses the longest domain phrase ("id card" is KYC, not a payment card; "reload the page" is not a bonus)', () => {
    expect(intentsOf('I uploaded my id card and a bank statement')[0]).toBe('kyc_verification');
    expect(intentsOf('I uploaded my id card and a bank statement')).not.toContain('payment_methods');
    expect(intentsOf('I tried to reload the page but the game is still not loading')).not.toContain('bonus_inquiry');
  });

  it('does not treat gambling losses as a missing deposit', () => {
    expect(intentsOf('I deposited 200 and lost it all on roulette')).not.toContain('deposit_missing');
  });
});

describe('splitQuestions', () => {
  it('splits a two-topic sentence into two classified questions', () => {
    const q = splitQuestions('my btc withdrawal is pending for 2 days and also when do i get my weekly bonus?');
    expect(q).toEqual([
      { text: 'my btc withdrawal is pending for 2 days', intent: 'withdrawal_pending' },
      { text: 'when do i get my weekly bonus?', intent: 'bonus_inquiry' },
    ]);
  });

  it('handles numbered lists and drops greetings and sign-offs', () => {
    const q = splitQuestions('Hi team,\n1. how do i deposit with card?\n2. what is the wagering on the reload?\nThanks, John');
    expect(q.map((x) => x.intent)).toEqual(['deposit_help', 'wagering_requirement']);
    expect(q[0]?.text).toBe('how do i deposit with card?');
  });

  it('keeps a follow-up request with the issue it refers to', () => {
    expect(splitQuestions("My deposit hasn't arrived. Can you check?")).toEqual([
      { text: "My deposit hasn't arrived. Can you check?", intent: 'deposit_missing' },
    ]);
    expect(splitQuestions('Hi, can you help me? My withdrawal is pending since yesterday.')).toEqual([
      { text: 'can you help me? My withdrawal is pending since yesterday.', intent: 'withdrawal_pending' },
    ]);
  });

  it('starts a new question after "also"/"btw" and keeps unclassified questions with intent general or null', () => {
    const q = splitQuestions("I can't log in. Also, is there rakeback for Platinum?");
    expect(q.map((x) => x.intent)).toEqual(['account_access', 'bonus_inquiry']);
    expect(splitQuestions('Are you licensed in Canada?')).toEqual([{ text: 'Are you licensed in Canada?', intent: 'general' }]);
  });

  it('splits inline numbered lists and understands curly apostrophes', () => {
    const q = splitQuestions('I have 3 questions. 1) how to change my email 2) where to find the vault 3) how do I enable 2fa');
    expect(q).toEqual([
      { text: 'how to change my email', intent: 'account_access' },
      { text: 'where to find the vault', intent: 'account_security' },
      { text: 'how do I enable 2fa', intent: 'account_security' },
    ]);
    expect(splitQuestions('I can’t log in. Also, what’s the rakeback for Platinum?')).toEqual([
      { text: 'I can’t log in.', intent: 'account_access' },
      { text: 'what’s the rakeback for Platinum?', intent: 'bonus_inquiry' },
    ]);
  });

  it('does not split decimals, URLs or emails', () => {
    const q = splitQuestions('I sent 0.05 BTC from stake.com/wallet yesterday, why is it not credited?');
    expect(q).toHaveLength(1);
    expect(q[0]?.text).toContain('0.05 BTC from stake.com/wallet');
  });

  it('drops pure chatter and returns at most 6 questions', () => {
    expect(splitQuestions('Hello? Thanks, John')).toEqual([]);
    const many = [
      'How do I deposit?',
      'Also what is the minimum withdrawal?',
      'Also when is the weekly bonus?',
      'Also how do I reach Platinum?',
      'Also why was my bet voided?',
      'Also how do I reset my 2FA?',
      'Also how does the affiliate program work?',
    ].join(' ');
    expect(splitQuestions(many)).toHaveLength(6);
  });
});

describe('detectSentiment', () => {
  it.each([
    ['YOU ARE THIEVES GIVE ME MY MONEY BACK NOW!!!', 'angry'],
    ['WHY IS MY WITHDRAWAL STILL NOT DONE', 'angry'],
    ['this is f***ing ridiculous', 'angry'],
    ['I will contact my lawyer and report you to the Curacao regulator', 'angry'],
    ['Still waiting for my withdrawal, third time asking', 'frustrated'],
    ['nobody answers my emails, no response for 3 days', 'frustrated'],
    ["I don't understand how the wagering works", 'confused'],
    ['how do I find my deposit address?', 'confused'],
    ['Thanks a lot, you guys are awesome!', 'positive'],
    ['Thanks, but my withdrawal is still pending', 'frustrated'],
    ['I have asked you 3 times already', 'frustrated'],
    ['I won 2 times in a row on Plinko', 'neutral'],
    ['Thanks again for the help', 'positive'],
    ['my withdrawal got DENIED twice. its MY money', 'angry'],
    ['I want it credited right now', 'angry'],
    ['it is STILL not in my account', 'frustrated'],
    ['why cant I withdraw??', 'frustrated'],
    ['what does that even mean?', 'confused'],
    ['I sent 0.05 BTC and USDT on TRC20 via BSC', 'neutral'],
    ['Is this a scam email? I got a message asking for my 2fa code', 'neutral'],
    ['My deposit is 100 USDT', 'neutral'],
  ] as const)('%s -> %s', (text, sentiment) => {
    expect(detectSentiment(text).sentiment).toBe(sentiment);
  });

  it('scores negative sentiments below zero and positive above zero', () => {
    expect(detectSentiment('you are scammers').score).toBeLessThan(-0.5);
    expect(detectSentiment('still waiting').score).toBeLessThan(0);
    expect(detectSentiment('thank you, great support').score).toBeGreaterThan(0);
    expect(detectSentiment('').score).toBe(0);
  });
});

describe('detectRgRisk', () => {
  it('flags critical self-harm wording', () => {
    const rg = detectRgRisk('I lost everything, I want to end my life');
    expect(rg).toMatchObject({ risk: true, critical: true });
    expect(rg.signals).toEqual(expect.arrayContaining(['lost everything', 'end my life']));
  });

  it('flags non-critical problem gambling wording', () => {
    const rg = detectRgRisk("I think I'm addicted, I can’t stop gambling. Please exclude me");
    expect(rg.risk).toBe(true);
    expect(rg.critical).toBe(false);
    expect(rg.signals).toEqual(expect.arrayContaining(['addicted', "can't stop gambling", 'exclude me']));
  });

  it('uses word boundaries and ignores normal messages', () => {
    expect(detectRgRisk('my withdrawal is pending').risk).toBe(false);
    expect(detectRgRisk('the suicideboys concert').risk).toBe(false);
  });
});

describe('detectUrgency', () => {
  function urgencyOf(text: string) {
    const { sentiment } = detectSentiment(text);
    const rg = detectRgRisk(text);
    return detectUrgency(text, { sentiment, entities: extractEntities(text), rgCritical: rg.critical, rgRisk: rg.risk });
  }

  it('is critical for self-harm wording', () => {
    expect(urgencyOf('i want to kill myself').urgency).toBe('critical');
  });

  it.each([
    ['urgent!! my withdrawal is pending', 'Customer says it is urgent'],
    ['I withdrew 5,000 USDT and it is still pending', 'Large amount (1,000+)'],
    ['I have been waiting for days for my deposit', 'Waiting 24 hours or longer'],
    ['my withdrawal has been pending for 3 days', 'Waiting 24 hours or longer'],
    ['I will do a chargeback with my bank', 'Chargeback threat'],
    ['I will contact my lawyer', 'Legal or regulator threat'],
    ['you are scammers', 'Customer is angry'],
    ["I'm addicted, please exclude me", 'Responsible gambling risk'],
  ])('%s -> high (%s)', (text, reason) => {
    const u = urgencyOf(text);
    expect(u.urgency).toBe('high');
    expect(u.reasons).toContain(reason);
  });

  it('is low for a positive thanks-only message and normal otherwise', () => {
    expect(urgencyOf('Thank you, have a nice day!').urgency).toBe('low');
    expect(urgencyOf('thanks! when do I get my weekly bonus?').urgency).toBe('normal');
    expect(urgencyOf('my withdrawal has been pending for 2 hours').urgency).toBe('normal');
    expect(urgencyOf('is the weekly bonus paid every 7 days?').urgency).toBe('normal');
  });
});

describe('isLikelyNonEnglish', () => {
  it.each([
    'Olá, meu saque está pendente há 3 dias e ainda não recebi. Podem verificar?',
    'Здравствуйте, мой вывод висит уже два дня, когда придут деньги?',
    'Merhaba, 2 gündür para çekme talebim bekliyor, neden hala onaylanmadı?',
    'Hola, mi retiro está pendiente desde ayer, por favor ayuda',
    '我的提款还没有到账',
  ])('detects non-English: %s', (text) => {
    expect(isLikelyNonEnglish(text)).toBe(true);
  });

  it.each([
    'BTC withdrawal pending 2 days',
    'ok thanks',
    'Hi, my name is José García and my withdrawal is pending',
    'kyc lvl 2 rejected??',
    '👍👍',
    '12345',
  ])('keeps English / undecidable as English: %s', (text) => {
    expect(isLikelyNonEnglish(text)).toBe(false);
  });
});

describe('extractKeywords', () => {
  it('puts domain terms first, drops stopwords and keeps max 12 unique keywords', () => {
    const k = extractKeywords('Hi, my weekly bonus is missing and the tx hash shows confirmations, please check asap');
    expect(k.slice(0, 3)).toEqual(['weekly bonus', 'missing', 'tx hash']);
    expect(k).not.toContain('my');
    expect(k).not.toContain('please');
    expect(new Set(k).size).toBe(k.length);
    expect(extractKeywords('word '.repeat(5) + Array.from({ length: 30 }, (_, i) => `token${String.fromCharCode(97 + (i % 26))}x${i}`).join(' ')).length).toBeLessThanOrEqual(12);
  });

  it('never returns personal data, ids or hashes', () => {
    const k = extractKeywords(`My name is John Smith, email john.smith@gmail.com, username jsmith_99, tx ${TX}`);
    for (const token of ['john', 'smith', 'gmail', 'jsmith', TX.toLowerCase()]) expect(k).not.toContain(token);
  });
});

describe('analyzeMessage', () => {
  it('assembles a full local analysis', () => {
    const a = analyzeMessage('my btc withdrawal is pending for 2 days and also when do i get my weekly bonus?');
    expect(a.source).toBe('local');
    expect(a.intents.map((i) => i.intent).slice(0, 2)).toEqual(['withdrawal_pending', 'bonus_inquiry']);
    expect(a.questions.map((q) => q.intent)).toEqual(['withdrawal_pending', 'bonus_inquiry']);
    expect(a.entities.map((e) => e.type)).toEqual(['crypto', 'duration', 'bonus_name']);
    expect(a.urgency).toBe('high');
    expect(a.wordCount).toBe(17);
    expect(a.isLikelyNonEnglish).toBe(false);
    expect(a.rgRisk).toBe(false);
  });

  it('returns a neutral, empty analysis for empty input', () => {
    expect(analyzeMessage('  \n ')).toEqual({
      intents: [],
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
      wordCount: 0,
      source: 'local',
    });
  });

  it('handles emoji-only messages', () => {
    const a = analyzeMessage('😡😡😡');
    expect(a.intents).toEqual([{ intent: 'general', score: 0.3 }]);
    expect(a.sentiment).toBe('angry');
    expect(a.wordCount).toBe(0);
    expect(a.questions).toEqual([]);
    expect(a.isLikelyNonEnglish).toBe(false);
    expect(analyzeMessage('👍').urgency).toBe('low');
  });

  it('marks RG risk and critical urgency', () => {
    const a = analyzeMessage("I lost everything gambling and I don't want to live anymore");
    expect(a.rgRisk).toBe(true);
    expect(a.urgency).toBe('critical');
    expect(a.intents[0]?.intent).toBe('responsible_gambling');
  });

  it('flags non-English messages', () => {
    const a = analyzeMessage('Olá, meu saque está pendente há 3 dias');
    expect(a.isLikelyNonEnglish).toBe(true);
    expect(a.intents[0]?.intent).toBe('general');
  });

  it('handles a very long input quickly and within limits', () => {
    const chunk = `Hi, my withdrawal of 1,250 USDT on TRC20 is pending for 3 days. Bet ID casino:123456789012. Email me at a.b@example.com. When do I get my weekly bonus? I am Platinum IV. `;
    const text = chunk.repeat(Math.ceil(8000 / chunk.length)).slice(0, 8000);
    const t0 = performance.now();
    const a = analyzeMessage(text);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(a.intents.length).toBeLessThanOrEqual(3);
    expect(a.questions.length).toBeLessThanOrEqual(6);
    expect(a.keywords.length).toBeLessThanOrEqual(12);
    for (let i = 1; i < a.entities.length; i++) {
      expect(a.entities[i]!.start).toBeGreaterThanOrEqual(a.entities[i - 1]!.end);
    }
  });

  it('analyzes a 1000-character message in < 5 ms on average (200 runs)', () => {
    const base =
      "Hello support, my BTC withdrawal of 0.05 BTC to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq has been pending for 2 days and I still haven't received it. " +
      'I also deposited 250 USDT on TRC20 yesterday and it is not showing. Can you check? Also when do I get my weekly bonus, I am Platinum IV. ' +
      'This is really frustrating!!! Thanks, John';
    let text = '';
    while (text.length < 1000) text += `${base} `;
    text = text.slice(0, 1000);
    for (let i = 0; i < 20; i++) analyzeMessage(text);
    const runs = 200;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) analyzeMessage(text);
    const avg = (performance.now() - t0) / runs;
    expect(avg).toBeLessThan(5);
  });
});

describe('review regressions', () => {
  it('does not treat codes and acronyms (2FA, RTP, ETA, AML) as shouting', () => {
    expect(detectSentiment('How do I set up 2FA?').sentiment).toBe('confused');
    expect(detectSentiment('what is the RTP').sentiment).toBe('neutral');
    expect(detectSentiment('My ETA for the withdrawal?').sentiment).toBe('neutral');
    expect(detectSentiment('I sent BUSD and SHIB').sentiment).toBe('neutral');
    expect(detectSentiment("Hi! I'd like to add 2FA before my next withdrawal").sentiment).toBe('neutral');
  });

  it('reads shouting and "!!!" in a purely positive message as enthusiasm, not anger', () => {
    expect(detectSentiment('THANK YOU SO MUCH').sentiment).toBe('positive');
    expect(detectSentiment('Great!!! no problem').sentiment).toBe('positive');
    expect(detectSentiment('Thank you! I appreciate it!!!').sentiment).toBe('positive');
    expect(detectSentiment('Thanks but WHERE IS MY MONEY').sentiment).toBe('angry');
    expect(detectSentiment('Thanks!!! Why is my deposit not here').sentiment).toBe('angry');
    expect(detectSentiment('WHERE IS MY MONEY').sentiment).toBe('angry');
  });

  it('does not make a thank-you urgent or a complaint', () => {
    const a = analyzeMessage('Thank you so much!!!');
    expect(a.sentiment).toBe('positive');
    expect(a.urgency).toBe('low');
    expect(a.intents).toEqual([{ intent: 'general', score: 0.3 }]);
  });

  it('does not count neutral "still possible" / "still have a question" as frustration', () => {
    expect(detectSentiment('Is it still possible to claim?').sentiment).toBe('neutral');
    expect(detectSentiment('I still have a question about rakeback').sentiment).toBe('neutral');
    expect(detectSentiment('it is still not in my account').sentiment).toBe('frustrated');
  });

  it.each([
    ["I've been playing on Stake for 2 years and never got a bonus", 'normal'],
    ['I created my account 3 years ago, how do I change my email?', 'normal'],
    ['I made my account 2 months ago, how do I get rakeback', 'normal'],
    ['I am over 18 years old, why do you need my id', 'normal'],
    ["I've been playing for the last 2 years", 'normal'],
    ['My deposit is not showing for 2 days', 'high'],
    ["it's been days and my withdrawal is not here", 'high'],
    ['It has been 3 days since my withdrawal', 'high'],
    ['I uploaded my documents 5 days ago', 'high'],
    ['I withdrew 2 days ago and nothing', 'high'],
    ['my withdrawal is 3 days pending', 'high'],
    ['deposit sent 2 days and still nothing', 'high'],
  ] as const)('only waits tied to an open request are long waits: %s -> %s', (text, urgency) => {
    expect(analyzeMessage(text).urgency).toBe(urgency);
  });

  it.each([
    ['I accidentally sent BTC to my ETH deposit address', 'deposit_missing'],
    ['I want to exclude myself', 'responsible_gambling'],
    ["it's been days and my withdrawal is not here", 'withdrawal_pending'],
    ["I didn't get the verification code by sms", 'account_access'],
    ['I want to change the email address on my account, how do I do that?', 'account_access'],
    ["I can't access the site from my country", 'technical_issue'],
    ['the live dealer stream keeps buffering', 'technical_issue'],
  ] as const)('closes intent gaps: %s -> %s', (text, intent) => {
    expect(intentsOf(text)[0]).toBe(intent);
  });

  it('does not count a verification code as a bonus code', () => {
    expect(intentsOf("I didn't get the verification code by sms")).not.toContain('bonus_inquiry');
    expect(intentsOf('where do I enter the bonus code?')[0]).toBe('bonus_inquiry');
  });

  it('flags self-exclusion wording as RG risk', () => {
    expect(detectRgRisk('I want to exclude myself').risk).toBe(true);
    expect(detectRgRisk('please block myself from the casino').risk).toBe(true);
    expect(detectRgRisk('I self-excluded last year').risk).toBe(true);
  });

  it('keeps every bullet of a list as its own question', () => {
    const q = splitQuestions("I have a few questions:\n- how do I deposit with card\n- what's the max withdrawal\n- do you have a mobile app");
    expect(q.map((x) => x.text)).toEqual(['how do I deposit with card', "what's the max withdrawal", 'do you have a mobile app']);
    expect(q.map((x) => x.intent)).toEqual(['deposit_help', 'withdrawal_limits', null]);
  });

  it('keeps topic-less follow-up questions with the context before them', () => {
    expect(splitQuestions('I deposited 50 USDT yesterday. Where is my balance?')).toEqual([
      { text: 'I deposited 50 USDT yesterday. Where is my balance?', intent: 'deposit_missing' },
    ]);
  });

  it('drops a trailing "Thank you" from the last question', () => {
    expect(splitQuestions('My withdrawal is stuck. It has been 3 days. Please respond. Thank you.')).toEqual([
      { text: 'My withdrawal is stuck. It has been 3 days. Please respond.', intent: 'withdrawal_pending' },
    ]);
  });

  it('detects short foreign messages with one known foreign word', () => {
    expect(isLikelyNonEnglish('Merhaba bonusum gelmedi')).toBe(true);
    expect(isLikelyNonEnglish('gracias amigo')).toBe(true);
    expect(isLikelyNonEnglish('Diego Garcia Lopez')).toBe(false);
    expect(isLikelyNonEnglish('Hola bro')).toBe(false);
  });
});
