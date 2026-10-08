/**
 * Recommendation quality on a realistic iGaming macro library with labeled customer messages, using the
 * builtin embedder (no network). Analysis objects are hand-built to resemble what the local analyzer
 * produces, including some messages where the analyzer finds no useful intent.
 */
import { describe, expect, it } from 'vitest';
import type { Analysis, Intent, Macro, QuestionSpan } from '../../shared/types.js';
import { createBuiltinEmbedder } from './embedder.js';
import { MacroIndex } from './macroIndex.js';
import { buildLexicalQuery } from './query.js';
import { searchLexical } from './lexical.js';

// ---------------------------------------------------------------------------
// Fixture library
// ---------------------------------------------------------------------------

interface MacroSpec {
  title: string;
  intents: Intent[];
  triggers: string[];
  tags: string[];
  body: string;
  shortcut?: string;
}

function makeMacro(id: string, spec: MacroSpec, extra: Partial<Macro> = {}): Macro {
  return {
    id,
    title: spec.title,
    body: spec.body,
    categoryId: null,
    tags: spec.tags,
    intents: spec.intents,
    triggers: spec.triggers,
    notes: '',
    shortcut: spec.shortcut ?? id,
    version: 1,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    archivedAt: null,
    isFavorite: false,
    useCount: 0,
    lastUsedAt: null,
    verification: 'unverified',
    facts: [],
    ...extra,
  };
}

const LIBRARY: Record<string, MacroSpec> = {
  'dep-crypto-missing': {
    title: 'Crypto deposit not credited',
    intents: ['deposit_missing'],
    tags: ['deposit', 'crypto', 'confirmations'],
    triggers: ["my deposit hasn't arrived", 'I sent BTC but my balance is still 0', 'crypto deposit not showing in my wallet'],
    body: 'Hi {{user}}, crypto deposits are credited automatically once the transaction reaches the required number of network confirmations. Please send us the transaction hash (TXID) of your {{crypto}} deposit so we can track it on the blockchain explorer. If it is fully confirmed and still not in your balance, we will escalate it to our payments team right away.',
  },
  'dep-wrong-network': {
    title: 'Deposit sent on the wrong network',
    intents: ['deposit_missing', 'deposit_help'],
    tags: ['deposit', 'network', 'recovery'],
    triggers: ['I sent USDT on the wrong network', 'used ERC20 instead of TRC20', 'deposited to the wrong chain'],
    body: 'Hi {{user}}, deposits must be sent on the network shown next to your deposit address. Funds sent on an unsupported network or chain can only be recovered in some cases and recovery is not guaranteed. Please share the transaction hash, the network you used and the amount, and our payments team will check whether a recovery is possible.',
  },
  'dep-missing-tag': {
    title: 'Deposit sent without memo or destination tag',
    intents: ['deposit_missing'],
    tags: ['deposit', 'xrp', 'memo', 'tag'],
    triggers: ['I forgot the destination tag', 'deposit without memo', 'xrp deposit missing tag'],
    body: 'Hi {{user}}, some currencies such as XRP, EOS and BNB require a memo or destination tag in addition to the address. Without the tag we cannot match the deposit to your account automatically. Please send the transaction hash and a screenshot of the transfer from your wallet so we can credit it manually.',
  },
  'dep-buy-crypto': {
    title: 'Deposit with card or local currency (buy crypto)',
    intents: ['deposit_help', 'payment_methods'],
    tags: ['deposit', 'card', 'fiat', 'moonpay'],
    triggers: ['can I deposit with my bank card', 'how do I buy crypto with a credit card', 'deposit with local currency'],
    body: 'Hi {{user}}, you can buy crypto with a debit or credit card, Apple Pay or Google Pay through our partner providers directly from the Wallet: open Wallet, choose Buy Crypto, select the currency and amount and complete the purchase with the provider. The crypto is then deposited straight into your account.',
  },
  'dep-how-to': {
    title: 'How to make a crypto deposit',
    intents: ['deposit_help'],
    tags: ['deposit', 'address', 'wallet'],
    triggers: ['how do I deposit', 'where is my deposit address', 'how do I fund my account'],
    body: 'Hi {{user}}, to deposit open Wallet, select Deposit, choose the currency and network, then copy your personal deposit address or scan the QR code. Send the funds from your external wallet or exchange; they appear in your balance after the required confirmations.',
  },
  'wd-pending-crypto': {
    title: 'Crypto withdrawal pending',
    intents: ['withdrawal_pending'],
    tags: ['withdrawal', 'pending', 'crypto'],
    triggers: ['my withdrawal is pending', 'why is my cashout taking so long', 'withdrawal stuck in processing'],
    body: 'Hi {{user}}, most crypto withdrawals are processed within a few minutes. During network congestion, or when a withdrawal needs an additional check, it can take longer. Once it is sent, the transaction hash appears in your transaction history so you can follow it on the blockchain. Your {{crypto}} withdrawal is currently being processed and should arrive within {{eta_time}}.',
  },
  'wd-under-review': {
    title: 'Withdrawal on hold for security review',
    intents: ['withdrawal_pending'],
    tags: ['withdrawal', 'review', 'security'],
    triggers: ['my withdrawal is under review', 'why is my withdrawal on hold', 'withdrawal held for checks'],
    body: 'Hi {{user}}, your withdrawal has been placed on hold for a routine security review by our risk team. Reviews protect your account and are usually completed within {{eta_time}}. We may contact you if any additional information or verification is needed. Thank you for your patience.',
  },
  'wd-limits': {
    title: 'Minimum and maximum withdrawal amounts',
    intents: ['withdrawal_limits'],
    tags: ['withdrawal', 'limits', 'minimum'],
    triggers: ['what is the minimum withdrawal', 'maximum withdrawal per day', 'is there a withdrawal limit'],
    body: 'Hi {{user}}, the minimum withdrawal amount depends on the currency and is shown in the Withdraw tab of your Wallet before you confirm. There is no fixed maximum for crypto withdrawals, but large amounts may be split or reviewed for security.',
  },
  'wd-how-to': {
    title: 'How to withdraw winnings',
    intents: ['withdrawal_help'],
    tags: ['withdrawal', 'how to', 'wallet'],
    triggers: ['how do I withdraw', 'how to cash out my winnings', 'where is the withdraw button'],
    body: 'Hi {{user}}, to withdraw open Wallet, select Withdraw, choose the currency and network, paste the receiving address from your external wallet and enter the amount. Double check the address and network before confirming, because blockchain transactions cannot be reversed.',
  },
  'wd-wrong-address': {
    title: 'Withdrawal sent to the wrong address',
    intents: ['withdrawal_help'],
    tags: ['withdrawal', 'address', 'irreversible'],
    triggers: ['I withdrew to the wrong wallet address', 'sent my withdrawal to the wrong address', 'can you reverse my withdrawal'],
    body: 'Hi {{user}}, we are sorry to hear that. Once a withdrawal is broadcast to the blockchain it cannot be cancelled or reversed by us. We recommend contacting the owner of the receiving address or the exchange that hosts it with the transaction hash; they are the only ones who can return the funds.',
  },
  'wd-fee': {
    title: 'Withdrawal network fee',
    intents: ['withdrawal_help'],
    tags: ['withdrawal', 'fee', 'network fee'],
    triggers: ['why was a fee deducted from my withdrawal', 'I received less than I withdrew', 'what is the withdrawal fee'],
    body: 'Hi {{user}}, every crypto withdrawal includes a network fee that is paid to the blockchain miners or validators, not to us. The fee depends on the currency and current network conditions and is displayed before you confirm the withdrawal.',
  },
  'kyc-level2': {
    title: 'Account verification (KYC level 2)',
    intents: ['kyc_verification'],
    tags: ['kyc', 'verification', 'id'],
    triggers: ['how do I verify my account', 'level 2 verification', 'what documents do I need to verify'],
    body: 'Hi {{user}}, to complete verification go to Settings, then Verify, and fill in your personal details. For level 2 you will need a valid government-issued photo ID such as a passport, national ID card or driver license. Make sure the photo is clear and all four corners are visible.',
  },
  'kyc-proof-address': {
    title: 'Proof of address (KYC level 3)',
    intents: ['kyc_verification'],
    tags: ['kyc', 'proof of address', 'level 3'],
    triggers: ['what counts as proof of address', 'is a utility bill accepted', 'level 3 verification'],
    body: 'Hi {{user}}, for level 3 please upload a proof of address dated within the last 3 months, such as a utility bill, bank statement or government letter. It must show your full name and residential address and match the details on your account.',
  },
  'kyc-rejected': {
    title: 'Verification documents rejected',
    intents: ['kyc_verification'],
    tags: ['kyc', 'rejected', 'documents'],
    triggers: ['my documents were rejected', 'why did my verification fail', 'kyc declined again'],
    body: 'Hi {{user}}, documents are usually rejected when the image is blurry, cropped, expired or when the name does not match your account details. Please upload a new, clear photo of the full document with all corners visible and our team will review it again.',
  },
  'kyc-source-of-funds': {
    title: 'Source of funds request',
    intents: ['kyc_verification'],
    tags: ['kyc', 'source of funds', 'aml'],
    triggers: ['why do you need my source of funds', 'what source of income documents do you accept', 'why are you asking for my bank statements'],
    body: 'Hi {{user}}, as a licensed operator we are required to confirm the source of funds used on the platform. Accepted documents include recent payslips, bank statements, tax returns or proof of sale of assets. Your documents are handled confidentially and only used for this check.',
  },
  'acc-2fa-lost': {
    title: 'Lost access to 2FA authenticator',
    intents: ['account_access'],
    tags: ['2fa', 'authenticator', 'login'],
    triggers: ['I lost my 2FA', 'new phone and no authenticator code', "can't log in without the 2fa code"],
    body: 'Hi {{user}}, for your security a two-factor authentication reset requires identity confirmation. Please reply with a selfie holding your ID and a note with today\'s date and your username. Once confirmed, we will remove 2FA so you can set it up again on your new device.',
  },
  'acc-password-reset': {
    title: 'Reset your password',
    intents: ['account_access'],
    tags: ['password', 'login', 'reset'],
    triggers: ['I forgot my password', 'password reset email not received', "I can't log in"],
    body: 'Hi {{user}}, click Forgot Password on the login screen and enter the email address on your account. The reset link is valid for a limited time; if it does not arrive within a few minutes, please check your spam or junk folder.',
  },
  'acc-hacked': {
    title: 'Account compromised or hacked',
    intents: ['account_security', 'account_access'],
    tags: ['security', 'hacked', 'unauthorized'],
    triggers: ['my account was hacked', 'someone logged into my account', 'there is an unauthorized withdrawal'],
    body: 'Hi {{user}}, we have temporarily locked your account to protect your funds while our security team investigates. Please change the password of your email account, enable two-factor authentication and do not share codes with anyone. We will contact you with the results of the investigation.',
  },
  'acc-phishing': {
    title: 'Phishing and fake support messages',
    intents: ['account_security'],
    tags: ['phishing', 'security', 'scam email'],
    triggers: ['is this email from you real', 'I got a suspicious email', 'fake support asked for my password'],
    body: 'Hi {{user}}, we will never ask for your password, 2FA codes or seed phrase. Messages asking for them are phishing attempts. Please do not click the links, report the message to us, and only log in through the official website or a verified mirror.',
  },
  'vip-progress': {
    title: 'VIP progress and ranks',
    intents: ['vip_program'],
    tags: ['vip', 'rank', 'progress'],
    triggers: ['how do I rank up', 'when do I reach gold', 'how is vip progress calculated'],
    body: 'Hi {{user}}, VIP progress is based on the total amount you wager across casino and sports. Each rank, from Bronze through Silver, Gold, Platinum and Diamond, unlocks better rewards. You can follow your progress to the next rank in the VIP section of your profile.',
  },
  'vip-host': {
    title: 'Dedicated VIP host',
    intents: ['vip_program'],
    tags: ['vip', 'host', 'account manager'],
    triggers: ['can I get a VIP host', 'who is my account manager', 'how do I contact my vip host'],
    body: 'Hi {{user}}, dedicated VIP hosts are assigned to players from a certain VIP rank. Your host can help with tailored rewards and priority support. At your current rank of {{vip_rank}} our VIP team will review your account and reach out by email.',
  },
  'bonus-reload': {
    title: 'Reload bonus',
    intents: ['bonus_inquiry', 'vip_program'],
    tags: ['reload', 'bonus', 'vip'],
    triggers: ['how do I claim my reload', 'daily reload is not working', 'where is my reload'],
    body: 'Hi {{user}}, reloads are offered to eligible VIP players and can be claimed at regular intervals from the VIP section under Reload. If the claim button is not visible, your reload period may have ended or the next claim is not available yet.',
  },
  'bonus-weekly': {
    title: 'Weekly bonus',
    intents: ['bonus_inquiry'],
    tags: ['weekly bonus', 'bonus'],
    triggers: ['when is the weekly bonus', "I didn't get my weekly bonus", 'weekly boost not received'],
    body: 'Hi {{user}}, the weekly bonus is sent every Saturday by email to eligible players who wagered during the previous seven days. The amount depends on your activity and VIP rank. Please also check your spam folder for the claim email.',
  },
  'bonus-monthly': {
    title: 'Monthly bonus',
    intents: ['bonus_inquiry'],
    tags: ['monthly bonus', 'bonus'],
    triggers: ['when is the monthly bonus paid', "I didn't receive the monthly bonus", 'monthly bonus amount'],
    body: 'Hi {{user}}, the monthly bonus is sent by email once a month to eligible players based on their activity over the past month. Make sure you are subscribed to our emails so you do not miss the claim link.',
  },
  'bonus-rakeback': {
    title: 'Rakeback explained',
    intents: ['bonus_inquiry', 'vip_program'],
    tags: ['rakeback', 'vip'],
    triggers: ['how does rakeback work', 'how do I claim rakeback', 'what is my rakeback percentage'],
    body: 'Hi {{user}}, rakeback returns a percentage of the house edge on every bet you place. It accumulates in real time and can be claimed at any moment from the VIP section, under Rakeback, once it is activated for your rank.',
  },
  'bonus-welcome': {
    title: 'Welcome offer and deposit bonus',
    intents: ['bonus_inquiry', 'wagering_requirement'],
    tags: ['welcome offer', 'bonus', 'new player'],
    triggers: ['is there a welcome bonus', 'first deposit bonus', 'do new players get a sign up bonus'],
    body: 'Hi {{user}}, new players can claim the welcome offer on their first deposit when it is available in their region. The bonus comes with wagering requirements and terms that are shown on the Promotions page before you opt in.',
  },
  'wagering-explained': {
    title: 'Wagering requirements explained',
    intents: ['wagering_requirement'],
    tags: ['wagering', 'rollover', 'playthrough'],
    triggers: ['what is a wagering requirement', 'how much do I need to wager', 'what does rollover mean'],
    body: 'Hi {{user}}, a wagering requirement is the amount you need to bet before bonus funds can be withdrawn. For example, a 40x rollover on a 100 bonus means 4000 in total bets. Different games contribute different percentages towards the requirement.',
  },
  'rg-self-exclusion': {
    title: 'Self-exclusion request',
    intents: ['responsible_gambling'],
    tags: ['self exclusion', 'responsible gambling'],
    triggers: ['I want to self exclude', 'please block me from gambling', 'exclude my account for a year'],
    body: 'Hi {{user}}, thank you for reaching out, we take this very seriously. We can self-exclude your account for a period you choose; during that time you will not be able to log in or play and the exclusion cannot be reversed early. Please confirm the period you would like. Independent support is also available through organisations such as GamCare and Gamblers Anonymous.',
  },
  'rg-limits-breaks': {
    title: 'Gambling limits and taking a break',
    intents: ['responsible_gambling'],
    tags: ['responsible gambling', 'deposit limit', 'break'],
    triggers: ['can you set a deposit limit for me', 'I want to take a break from gambling', 'cooling off period'],
    body: 'Hi {{user}}, you can set a gambling limit on deposits or losses in Settings under Responsible Gambling, or ask us to apply a break in play (cooling off) for a short period. Limits take effect immediately; raising them again requires a waiting period.',
  },
  'acc-closure': {
    title: 'Account closure request',
    intents: ['account_closure'],
    tags: ['close account', 'delete account'],
    triggers: ['close my account', 'delete my account permanently', 'deactivate my profile'],
    body: 'Hi {{user}}, we can close your account for you. Before we do, please withdraw any remaining balance. If you are closing the account because of gambling concerns, we recommend self-exclusion instead, which also prevents opening new accounts.',
  },
  'sports-void': {
    title: 'Voided sports bet',
    intents: ['sports_betting'],
    tags: ['sports', 'void', 'bet'],
    triggers: ['why was my bet voided', 'my bet got cancelled', 'void bet on my parlay'],
    body: 'Hi {{user}}, a bet can be voided when a match is postponed or abandoned, when a market is settled incorrectly by the feed or when odds were offered in obvious error. For a parlay the voided leg is removed and the rest of the bet stays active with adjusted odds. Your stake on the voided selection has been returned.',
  },
  'sports-cashout-unavailable': {
    title: 'Cash out unavailable on a sports bet',
    intents: ['sports_betting'],
    tags: ['sports', 'cash out', 'live'],
    triggers: ['the cash out button is greyed out', "why can't I cash out my bet", 'cashout not available on live bet'],
    body: 'Hi {{user}}, the cash out option on a sports bet is temporarily suspended when the market is suspended, during key moments of a live event or when a selection is no longer available for cash out. It becomes available again when the market reopens.',
  },
  'sports-settlement': {
    title: 'Bet settled incorrectly',
    intents: ['sports_betting', 'complaint'],
    tags: ['sports', 'settlement', 'result'],
    triggers: ['my bet was settled wrong', 'I won but it shows as lost', 'wrong result on my bet'],
    body: 'Hi {{user}}, I am sorry for the trouble. Please send the bet ID so our trading team can review the settlement against the official result. If the bet was settled incorrectly it will be resettled and your balance updated automatically.',
  },
  'casino-game-freeze': {
    title: 'Casino game froze or crashed',
    intents: ['casino_games', 'technical_issue'],
    tags: ['casino', 'freeze', 'bet id'],
    triggers: ['the game froze mid spin', 'slot is stuck loading', 'game crashed during the bonus round'],
    body: 'Hi {{user}}, if a game freezes the round is completed on the game provider\'s server and any win is credited to your balance. Please refresh the page and reopen the game. If the balance looks wrong, send us the bet ID of the round so we can check it with the provider.',
  },
  'casino-provably-fair': {
    title: 'Provably fair games',
    intents: ['casino_games'],
    tags: ['provably fair', 'originals', 'seed'],
    triggers: ['is the game rigged', 'how do I verify a bet result', 'what are server seed and client seed'],
    body: 'Hi {{user}}, our Originals such as Dice, Plinko and Mines are provably fair: every result is generated from a server seed, a client seed and a nonce. You can change your client seed at any time and verify every past bet result in the Fairness section.',
  },
  'tech-site-loading': {
    title: 'Website not loading',
    intents: ['technical_issue'],
    tags: ['technical', 'browser', 'cache'],
    triggers: ['the website is not loading', 'the page is blank', 'the app keeps crashing'],
    body: 'Hi {{user}}, please clear your browser cache and cookies, disable browser extensions and try again, or use a different browser or device. If the problem continues, send us a screenshot and tell us which browser and device you are using.',
  },
  'tech-restricted-region': {
    title: 'Restricted region and VPN use',
    intents: ['technical_issue'],
    tags: ['restricted', 'vpn', 'region'],
    triggers: ['the site is blocked in my country', 'can I use a VPN', 'access restricted in my region'],
    body: 'Hi {{user}}, our services are not available in some countries due to licensing restrictions. Using a VPN to bypass these restrictions is not allowed under our terms and can lead to the account being closed.',
  },
  affiliate: {
    title: 'Affiliate and referral program',
    intents: ['affiliate'],
    tags: ['affiliate', 'referral', 'commission'],
    triggers: ['how do I become an affiliate', 'how does referral commission work', 'where is my affiliate code'],
    body: 'Hi {{user}}, you can join our affiliate program from the Affiliate section of your profile. Create a campaign to get your referral link and code; you earn commission on the activity of players who sign up with it.',
  },
  'betting-limits': {
    title: 'Betting limits and max bet',
    intents: ['betting_limits'],
    tags: ['max bet', 'limits', 'sports'],
    triggers: ['why is my max bet limited', 'my stake limit is too low', 'can you raise my maximum bet'],
    body: 'Hi {{user}}, maximum bet amounts are set per market by our trading team and depend on the sport, league and market liquidity. Limits are reviewed regularly and we are unable to change them manually for individual accounts.',
  },
  'complaint-escalation': {
    title: 'Complaint acknowledgement and escalation',
    intents: ['complaint'],
    tags: ['complaint', 'escalation'],
    triggers: ['this is unacceptable', 'I want to file a formal complaint', 'you are scammers'],
    body: 'Hi {{user}}, I am sorry for your experience and I understand your frustration. I have escalated your complaint to the responsible team, who will review it carefully and get back to you by email as soon as possible.',
  },
  'general-anything-else': {
    title: 'Anything else I can help with?',
    intents: ['general'],
    tags: ['closing'],
    triggers: ['thanks', 'that is all', 'ok great'],
    body: 'Is there anything else I can help you with today, {{user}}?',
  },
};

const MACROS: Macro[] = Object.entries(LIBRARY).map(([id, spec]) => makeMacro(id, spec));

// ---------------------------------------------------------------------------
// Labeled messages
// ---------------------------------------------------------------------------

function analysisOf(intents: [Intent, number][], questions: QuestionSpan[] = []): Analysis {
  return {
    intents: intents.map(([intent, score]) => ({ intent, score })),
    sentiment: 'neutral',
    sentimentScore: 0,
    urgency: 'normal',
    urgencyReasons: [],
    entities: [],
    questions,
    keywords: [],
    rgRisk: false,
    rgSignals: [],
    isLikelyNonEnglish: false,
    wordCount: 0,
    source: 'local',
  };
}

interface Labeled {
  message: string;
  expected: string;
  intents: [Intent, number][];
}

/** A third of the messages carry no useful intent (general), as when the analyzer misses the topic. */
const LABELED: Labeled[] = [
  { message: "hey, I deposited 0.01 BTC two hours ago and it's still not in my balance", expected: 'dep-crypto-missing', intents: [['deposit_missing', 0.85]] },
  { message: 'my deposit of 200 usdt on trc20 is missing, here is the tx hash', expected: 'dep-crypto-missing', intents: [['deposit_missing', 0.8]] },
  { message: 'I sent USDT using ERC20 but your address was TRC20, can I get it back?', expected: 'dep-wrong-network', intents: [['deposit_missing', 0.6], ['deposit_help', 0.4]] },
  { message: 'I deposited XRP but forgot to put the destination tag', expected: 'dep-missing-tag', intents: [['general', 0.2]] },
  { message: "can i pay with my visa card? i don't have any crypto", expected: 'dep-buy-crypto', intents: [['deposit_help', 0.6], ['payment_methods', 0.5]] },
  { message: 'where do I find my deposit address for litecoin', expected: 'dep-how-to', intents: [['deposit_help', 0.8]] },
  { message: "my btc withdrawal has been pending for 3 hours, what's going on??", expected: 'wd-pending-crypto', intents: [['withdrawal_pending', 0.9]] },
  { message: 'why is my cashout taking forever', expected: 'wd-pending-crypto', intents: [['general', 0.2]] },
  { message: 'how long does it take for an eth withdrawal to arrive?', expected: 'wd-pending-crypto', intents: [['withdrawal_pending', 0.7]] },
  { message: "my withdrawal says it's on hold for review, how long does the review take", expected: 'wd-under-review', intents: [['withdrawal_pending', 0.8]] },
  { message: "what's the minimum amount I can withdraw in LTC?", expected: 'wd-limits', intents: [['withdrawal_limits', 0.8]] },
  { message: 'is there a maximum I can withdraw per day', expected: 'wd-limits', intents: [['general', 0.2]] },
  { message: 'how do I take my winnings out?', expected: 'wd-how-to', intents: [['withdrawal_help', 0.7]] },
  { message: 'I made a mistake and withdrew to the wrong wallet address, can you reverse it', expected: 'wd-wrong-address', intents: [['withdrawal_help', 0.7]] },
  { message: 'why did I get less than I withdrew? looks like you took a fee', expected: 'wd-fee', intents: [['withdrawal_help', 0.6]] },
  { message: 'what documents do you need to verify my account', expected: 'kyc-level2', intents: [['kyc_verification', 0.9]] },
  { message: 'do you accept a bank statement as proof of address?', expected: 'kyc-proof-address', intents: [['kyc_verification', 0.9]] },
  { message: 'my passport got rejected twice, why??', expected: 'kyc-rejected', intents: [['kyc_verification', 0.85]] },
  { message: 'why do you need my source of income? I already verified my ID', expected: 'kyc-source-of-funds', intents: [['kyc_verification', 0.7]] },
  { message: "I lost my phone and now I can't get the 2FA code to log in", expected: 'acc-2fa-lost', intents: [['account_access', 0.9]] },
  { message: 'forgot my password and the reset email never arrives', expected: 'acc-password-reset', intents: [['account_access', 0.85]] },
  { message: 'someone hacked my account and withdrew my whole balance!!', expected: 'acc-hacked', intents: [['account_security', 0.8], ['withdrawal_help', 0.3]] },
  { message: 'I got an email asking for my password and 2fa, is this legit or phishing?', expected: 'acc-phishing', intents: [['general', 0.2]] },
  { message: 'how much more do I need to wager to reach gold?', expected: 'vip-progress', intents: [['vip_program', 0.8], ['wagering_requirement', 0.3]] },
  { message: "can I have a personal VIP host? I'm platinum now", expected: 'vip-host', intents: [['vip_program', 0.85]] },
  { message: 'where do I claim my daily reload', expected: 'bonus-reload', intents: [['bonus_inquiry', 0.8]] },
  { message: "it's Saturday and I still didn't get my weekly bonus", expected: 'bonus-weekly', intents: [['bonus_inquiry', 0.85]] },
  { message: 'when does the monthly bonus come out?', expected: 'bonus-monthly', intents: [['general', 0.2]] },
  { message: 'how is rakeback calculated', expected: 'bonus-rakeback', intents: [['bonus_inquiry', 0.8]] },
  { message: 'do new players get any welcome bonus on the first deposit?', expected: 'bonus-welcome', intents: [['bonus_inquiry', 0.8], ['deposit_help', 0.3]] },
  { message: 'what does 40x rollover mean', expected: 'wagering-explained', intents: [['wagering_requirement', 0.85]] },
  { message: 'I need to stop. Please exclude me from the site for 6 months', expected: 'rg-self-exclusion', intents: [['responsible_gambling', 0.95]] },
  { message: 'I want to take a short break from gambling, like a week', expected: 'rg-limits-breaks', intents: [['general', 0.2]] },
  { message: 'please delete my account permanently', expected: 'acc-closure', intents: [['account_closure', 0.9]] },
  { message: 'my parlay got voided, why?', expected: 'sports-void', intents: [['sports_betting', 0.85]] },
  { message: 'the cash out button is not available on my live bet', expected: 'sports-cashout-unavailable', intents: [['general', 0.2]] },
  { message: 'my bet won but you settled it as a loss', expected: 'sports-settlement', intents: [['sports_betting', 0.8], ['complaint', 0.3]] },
  { message: 'the slot froze in the middle of my free spins', expected: 'casino-game-freeze', intents: [['casino_games', 0.6], ['technical_issue', 0.6]] },
  { message: 'how can I check that your dice game is fair and not rigged', expected: 'casino-provably-fair', intents: [['general', 0.2]] },
  { message: 'website just shows a white screen on chrome', expected: 'tech-site-loading', intents: [['technical_issue', 0.85]] },
  { message: 'stake is blocked in my country, can i use a vpn?', expected: 'tech-restricted-region', intents: [['technical_issue', 0.6]] },
  { message: 'I have a streaming channel, how can I earn commission by referring players', expected: 'affiliate', intents: [['affiliate', 0.85]] },
  { message: 'why is my maximum bet so low on football', expected: 'betting-limits', intents: [['general', 0.2]] },
  { message: "this is a joke, you're thieves and I want to file a complaint", expected: 'complaint-escalation', intents: [['complaint', 0.9]] },
];

const OPTS = { maxResults: 3, minConfidence: 45 };

async function buildIndex(macros: Macro[] = MACROS): Promise<MacroIndex> {
  const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
  await index.rebuild(macros, (m) => `k-${m.id}`);
  return index;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MacroIndex recommendation quality (builtin embedder)', () => {
  it('has a realistic fixture set', () => {
    expect(MACROS.length).toBeGreaterThanOrEqual(30);
    expect(LABELED.length).toBeGreaterThanOrEqual(40);
    for (const l of LABELED) expect(LIBRARY[l.expected], l.expected).toBeDefined();
  });

  it('reaches >= 85% top-1 and >= 95% top-3 accuracy on labeled messages', async () => {
    const index = await buildIndex();
    let top1 = 0;
    let top3 = 0;
    const misses: string[] = [];
    for (const l of LABELED) {
      const res = await index.search(l.message, analysisOf(l.intents), OPTS);
      const ids = res.recommendations.map((r) => r.macroId);
      if (ids[0] === l.expected) top1++;
      else misses.push(`${l.expected} <- "${l.message}" got [${ids.join(', ')}]`);
      if (ids.includes(l.expected)) top3++;
    }
    const top1Rate = top1 / LABELED.length;
    const top3Rate = top3 / LABELED.length;
    expect(top1Rate, misses.join('\n')).toBeGreaterThanOrEqual(0.85);
    expect(top3Rate, misses.join('\n')).toBeGreaterThanOrEqual(0.95);
  });

  it('gives clear matches high confidence and explains them', async () => {
    const index = await buildIndex();
    const res = await index.search(
      "my btc withdrawal has been pending for 3 hours, what's going on??",
      analysisOf([['withdrawal_pending', 0.9]]),
      OPTS,
    );
    const best = res.recommendations[0]!;
    expect(best.macroId).toBe('wd-pending-crypto');
    expect(best.confidence).toBeGreaterThanOrEqual(75);
    expect(best.confidence).toBeLessThanOrEqual(99);
    expect(res.noGoodMatch).toBe(false);
    expect(best.coversIntents).toEqual(['withdrawal_pending']);
    expect(best.matchedTerms).toEqual(expect.arrayContaining(['BTC', 'withdrawal', 'pending']));
    expect(best.matchedTerms.length).toBeLessThanOrEqual(6);
    expect(best.reason).toMatch(/^Matches the pending withdrawal question \(.+\)\.$/);
    expect(best.reason.length).toBeLessThanOrEqual(160);
    for (const v of Object.values(best.breakdown)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('gives partial matches a medium confidence', async () => {
    const index = await buildIndex();
    // Asks about a withdrawal but nothing in the library is about crypto staking.
    const res = await index.search('can I stake my withdrawal for interest?', analysisOf([['withdrawal_help', 0.4]]), OPTS);
    const best = res.recommendations[0]!;
    expect(best.confidence).toBeGreaterThanOrEqual(35);
    expect(best.confidence).toBeLessThanOrEqual(75);
  });

  it('is robust to typos', async () => {
    const index = await buildIndex();
    const cases: [string, string][] = [
      ['my withdrawl is pendng for 5 hours', 'wd-pending-crypto'],
      ['how do i verfy my acount', 'kyc-level2'],
      ['i forgot my pasword', 'acc-password-reset'],
      ['deposite not credted after 2 hours', 'dep-crypto-missing'],
      ['how dose rakebak work', 'bonus-rakeback'],
    ];
    for (const [message, expected] of cases) {
      const res = await index.search(message, analysisOf([['general', 0.2]]), OPTS);
      expect(res.recommendations[0]?.macroId, message).toBe(expected);
    }
  });

  it('flags unrelated messages as no good match', async () => {
    const index = await buildIndex();
    for (const message of ["what's the weather in Paris tomorrow", 'can you recommend a good pizza place near me']) {
      const res = await index.search(message, analysisOf([['general', 0.25]]), OPTS);
      expect(res.noGoodMatch, message).toBe(true);
      expect(res.recommendations[0]?.confidence ?? 0, message).toBeLessThan(35);
      expect(res.uncoveredIntents).toEqual([]);
    }
  });

  it('puts the best macro for a second question at #2', async () => {
    const index = await buildIndex();
    const message = 'My BTC withdrawal has been pending for hours. Also, how do I verify my account to level 2?';
    const res = await index.search(
      message,
      analysisOf(
        [
          ['withdrawal_pending', 0.8],
          ['kyc_verification', 0.6],
        ],
        [
          { text: 'My BTC withdrawal has been pending for hours.', intent: 'withdrawal_pending' },
          { text: 'how do I verify my account to level 2?', intent: 'kyc_verification' },
        ],
      ),
      OPTS,
    );
    expect(res.recommendations.slice(0, 2).map((r) => r.macroId)).toEqual(['wd-pending-crypto', 'kyc-level2']);
    expect(res.recommendations[1]!.confidence).toBeGreaterThanOrEqual(35);
    expect(res.uncoveredIntents).toEqual([]);
  });

  it('diversifies on a strong second intent even without question spans', async () => {
    const index = await buildIndex();
    const res = await index.search(
      "When do I get the weekly bonus? I also want to close my account after that, I'm done.",
      analysisOf([
        ['bonus_inquiry', 0.7],
        ['account_closure', 0.65],
      ]),
      OPTS,
    );
    const ids = res.recommendations.map((r) => r.macroId);
    expect(ids.slice(0, 2).sort()).toEqual(['acc-closure', 'bonus-weekly']);
    expect(res.uncoveredIntents).toEqual([]);
  });

  it('reports intents that no returned macro covers', async () => {
    const index = await buildIndex(MACROS.filter((m) => !m.intents.includes('affiliate')));
    const res = await index.search(
      'my withdrawal is pending. also how do I become an affiliate?',
      analysisOf(
        [
          ['withdrawal_pending', 0.8],
          ['affiliate', 0.6],
        ],
        [
          { text: 'my withdrawal is pending.', intent: 'withdrawal_pending' },
          { text: 'how do I become an affiliate?', intent: 'affiliate' },
        ],
      ),
      OPTS,
    );
    expect(res.recommendations[0]?.macroId).toBe('wd-pending-crypto');
    expect(res.uncoveredIntents).toEqual(['affiliate']);
  });

  it('rebuilds 2,000 macros in < 3 s and searches in < 50 ms on average', async () => {
    const big = generateLibrary(2000);
    const index = new MacroIndex({ embedder: createBuiltinEmbedder() });
    const t0 = performance.now();
    await index.rebuild(big, (m) => m.id);
    const rebuildMs = performance.now() - t0;
    expect(index.size()).toBe(2000);
    expect(rebuildMs).toBeLessThan(3000);

    const t1 = performance.now();
    for (const l of LABELED) await index.search(l.message, analysisOf(l.intents), OPTS);
    const avgMs = (performance.now() - t1) / LABELED.length;
    expect(avgMs).toBeLessThan(50);
  });
});

/** Deterministic large library: fixture macros with varied wording, products and filler sentences. */
function generateLibrary(count: number): Macro[] {
  const specs = Object.values(LIBRARY);
  const products = ['BTC', 'ETH', 'LTC', 'USDT', 'SOL', 'casino', 'sportsbook', 'poker', 'Originals', 'live casino'];
  const fillers = [
    'Our support team is available 24/7 via live chat.',
    'Please allow some extra time during weekends and holidays.',
    'You can find more details in our Help Center articles.',
    'We appreciate your patience while we look into this.',
    'Remember to keep your account details private.',
    'Promotions are subject to their own terms and conditions.',
  ];
  let seed = 42;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const out: Macro[] = [];
  for (let i = 0; i < count; i++) {
    const spec = specs[i % specs.length]!;
    const product = products[rand(products.length)]!;
    const filler = `${fillers[rand(fillers.length)]} ${fillers[rand(fillers.length)]}`;
    out.push(
      makeMacro(`gen-${i}`, {
        ...spec,
        title: `${spec.title} (${product} #${i})`,
        triggers: spec.triggers.map((t) => `${t} ${product.toLowerCase()}`),
        body: `${spec.body} ${filler} Reference ${product}-${i}.`,
        tags: [...spec.tags, product.toLowerCase(), `variant${i % 50}`],
      }),
    );
  }
  return out;
}

describe.runIf(process.env.DEBUG_SEARCH)('debug dump', () => {
  it('dumps', async () => {
    const index = await buildIndex();
    const rows: string[] = [];
    const all = [...LABELED, { message: "what's the weather in Paris tomorrow", expected: '-', intents: [['general', 0.25]] as [Intent, number][] }, { message: 'can you recommend a good pizza place near me', expected: '-', intents: [['general', 0.25]] as [Intent, number][] }, { message: 'can I stake my withdrawal for interest?', expected: '-', intents: [['withdrawal_help', 0.4]] as [Intent, number][] }, { message: 'my withdrawl is pendng for 5 hours', expected: 'wd-pending-crypto', intents: [['general', 0.2]] as [Intent, number][] }, { message: 'how do i verfy my acount', expected: 'kyc-level2', intents: [['general', 0.2]] as [Intent, number][] }, { message: 'deposite not credted after 2 hours', expected: 'dep-crypto-missing', intents: [['general', 0.2]] as [Intent, number][] }, { message: 'how dose rakebak work', expected: 'bonus-rakeback', intents: [['general', 0.2]] as [Intent, number][] }, { message: 'i forgot my pasword', expected: 'acc-password-reset', intents: [['general', 0.2]] as [Intent, number][] }];
    for (const l of all) {
      const res = await index.search(l.message, analysisOf(l.intents), { maxResults: 3, minConfidence: 45 });
      const ok = res.recommendations[0]?.macroId === l.expected ? 'OK ' : 'XX ';
      const q = buildLexicalQuery(l.message);
      const hits = searchLexical((index as any).state.lexical, q);
      rows.push(`${ok}${l.expected.padEnd(28)} "${l.message}" maxBm25=${hits[0]?.score.toFixed(1)} n=${q.terms.length - q.expansions.size} top=${hits[0]?.id} 2nd=${hits[1]?.score.toFixed(1)}`);
      for (const r of res.recommendations) rows.push(`     ${r.macroId.padEnd(28)} ${String(r.confidence).padStart(3)} s=${r.breakdown.semantic} l=${r.breakdown.lexical} i=${r.breakdown.intent} | ${r.reason} [${r.matchedTerms.join(',')}]`);
    }
    console.log(rows.join('\n'));
  });
});
