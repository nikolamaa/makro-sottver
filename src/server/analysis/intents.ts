/**
 * Intent scoring: weighted evidence per intent from the concept scanner (iGaming vocabulary) plus
 * intent-specific regexes, mapped to 0..1 with a saturating curve.
 */
import type { Intent, IntentScore } from '../../shared/types.js';
import { INTENTS } from '../../shared/types.js';
import { conceptWeight, has, prepare, type Prepared, termsOf } from './concepts.js';
import { TX_HASH_TEST_RE } from './entities.js';
import { GAME_TEST_RE, PROVIDER_TEST_RE } from './vocabulary.js';
import { detectRgRiskNorm, type RgRisk } from './rg.js';
import { round2 } from './text.js';

/** Raw evidence k: score = 1 - exp(-raw / k). raw 2.5 -> 0.68, raw 1.4 -> 0.47, raw 0.8 -> 0.31. */
const SATURATION_K = 2.2;
/** Intents below this score are not reported. */
const MIN_INTENT_SCORE = 0.15;
/** Returned for non-empty text without any intent evidence. */
const GENERAL_FALLBACK_SCORE = 0.3;
const MAX_INTENTS = 3;

const HOW_RE =
  /\b(?:how (?:do|can|to|does|should|would|will)\b|steps?\b|step by step|guide|instructions?|tutorial|explain|walk me through|help me|can i\b|could i\b|is it possible|possible to|where (?:do|can) i\b|what do i need)/;
const ELAPSED_RE =
  /\b(?:\d+|an?|one|two|three|four|five|few|couple(?: of)?|several|many)\s*(?:hours?|hrs?|days?|weeks?|months?|mins?|minutes?)\b|\b\d+\s*[hd]\b|\b(?:ago|since|yesterday|last (?:night|week|month)|(?:for|been) (?:hours|days|weeks|months|ages|so long|a while|a long time)|all day|forever|ages)\b/;
const WHEN_RE = /\b(?:when|how long|eta|by when)\b/;
const PENDING_EXTRA_RE =
  /\b(?:still (?:not|no|haven't|hasn't|waiting|pending)|taking (?:forever|ages|too long)|waiting|awaiting|in progress|not (?:yet )?(?:approved|processed|confirmed|completed)|status of)\b/;
const MISSING_EXTRA_RE =
  /\b(?:didn't (?:get|receive)|did not (?:get|receive)|haven't (?:got|gotten|received)|never (?:got|received|came)|not (?:in|on) my (?:wallet|balance|account)|balance (?:is |shows )?(?:still )?(?:0|zero|empty)|still (?:0|zero|empty)|nothing (?:arrived|came|showed up|shows up|appeared)|(?:didn't|did not|doesn't|does not|hasn't|has not|not) (?:show|showed|shown|showing|appear|appeared) up|where (?:is|are) (?:my|the) (?:money|funds|crypto|coins?))\b/;
const GAMBLING_LOSS_RE = /\blost (?:on|at|in|playing|betting|gambling|it all|everything|a bet|my bets?)\b/;
const WRONG_NETWORK_RE =
  /\b(?:wrong|different|incorrect|unsupported) (?:network|chain|blockchain|address|coin|currency|token|memo|tag)\b|\b(?:forgot|forget|without|missing|no|didn't (?:add|put|include|enter)|did not (?:add|put|include|enter))(?: to (?:add|put|include|enter))? (?:the |a |my )?(?:memo|tag|destination tag)\b/;
/** Crypto sent by mistake (wrong coin/address): a recovery case, handled like a missing deposit. */
const MISTAKEN_SEND_RE = /\b(?:accidentally|mistakenly|by mistake|by accident|wrongly)\b/;
const DEPOSIT_EXTRA_RE =
  /\b(?:deposit address|my stake (?:wallet|address)|sent (?:it |them |the (?:money|funds|coins?|crypto) )?to (?:my )?stake|sent (?:about |around |over )?\d[\d.,]*\s?k?\s?(?:usdt|usdc|btc|eth|ltc|xrp|trx|doge|sol|bnb|bch|ada|eos|matic|pol|dai|shib|crypto|coins?|euros?|eur|dollars?|usd|inr|rupees?|cad|brl|ngn))\b/;
/** "cash out" about a sports bet (cashout button/offer), not a withdrawal. */
const SPORTS_CASHOUT_RE =
  /\bcash ?-?out (?:button|option|offer|value|feature)\b|\bcash(?:ed)? ?-?out (?:my |the |a |this )?(?:bet|parlay|multi|acca|accumulator|ticket|slip)\b/;
const WITHDRAWAL_MONEY_RE = /\b(?:winnings|balance|money|funds|to my (?:wallet|bank|card|address))\b/;
const FEE_RE = /\bfees?\b/;
const WAGER_BEFORE_WITHDRAW_RE = /\bwager\w*(?:\s+\S+){0,6}?\s+(?:before|until|to)\s+(?:i\s+(?:can|could)\s+)?(?:withdraw|cash ?out)/;
const WAGERING_EXTRA_RE = /\b(?:bonus requirements?|active bonus|requirement to wager|wager(?:ing)? progress|remaining wager)\b/;
const WITHDRAW_BONUS_RE =
  /\b(?:withdraw\w*|cash ?out)(?:\s+\w+){0,3}?\s+(?:bonus|bonuses|reload|rakeback|free spins? winnings)\b|\bbonus(?:\s+\w+){0,4}?\s+(?:withdraw\w*|cash ?out)\b/;
const PAYMENT_EXTRA_RE =
  /\b(?:payment (?:methods?|options?)|pay(?:ing)? with|ways? to (?:pay|deposit|fund)|which (?:coins?|currencies|cryptos?|cryptocurrencies|methods?|cards?)|(?:supported|accepted|available) (?:coins?|currencies|cryptos?|methods?|payments?)|do you (?:accept|support|take)|accept (?:cards?|currencies|coins?)|(?:display|local|fiat) currency|change (?:my |the )?currency|currency (?:converter|conversion|settings?)|convert (?:my )?(?:crypto|balance|currency))\b/;
const RELOAD_PAGE_RE = /\b(?:reload(?:ed|ing)?|refresh(?:ed|ing)?) (?:the |my |this )?(?:page|site|website|browser|app|game|tab)\b/;
const ACCESS_VERIFY_RE = /\b(?:verification (?:code|email|link|sms)|verify (?:my |the )?(?:email|phone|number)|email verification|2fa|two factor)\b/;
/** "verify" about game fairness (seeds, provably fair), not identity documents. */
const FAIRNESS_VERIFY_RE = /\b(?:provabl[ey] fair\w*|(?:server|client) seeds?|verify (?:the |my |a )?(?:bet|result|game|hash|outcome|seed))\b/;
const DEPOSIT_ADDRESS_RE = /\bdeposit address\b/;
const ACCESS_EXTRA_RE =
  /\b(?:(?:can't|cannot|unable to|not able to|couldn't) (?:access|get into|open) (?:my )?account|code (?:not|never) (?:received|arriving|coming)|(?:didn't|did not|don't|haven't) (?:get|receive) (?:the |a |any |my )?(?:(?:verification|confirmation|login|security|2fa|sms|email) )?(?:code|email|sms)|change (?:my |the )?(?:email|phone|password)|reset (?:my )?(?:2fa|password|pw|pass|passwd|email)|disable 2fa|account(?: \S+)? (?:is |was |got |has been |been )?(?:locked|disabled|suspended|frozen|banned|deactivated)|locked (?:my )?account)\b/;
const TWO_FA_SETUP_RE =
  /\b(?:turn on|enable|set ?up|add|activate)\s+(?:the\s+|a\s+)?(?:2fa|two[- ]factor|authenticator|google authenticator|passkeys?)\b|\b(?:2fa|two[- ]factor)\b.{0,40}\b(?:set (?:it )?up|turn (?:it )?on|enable|activate)\b/;
const PHISHING_RE = /\b(?:e-?mail|message|sms|text|dm|link|website|site)\b.{0,160}?\b(?:legit|genuine|official|real|fake|phishing|scam)\b/;
const CLOSURE_EXTRA_RE =
  /\b(?:account (?:deleted|closed|removed|terminated)|(?:delete|close|remove|terminate|deactivate) (?:my |this )?(?:stake )?(?:account|acc|profile)|delete (?:all )?my data|gdpr|right to be forgotten)\b/;
const KYC_EXTRA_RE =
  /\b(?:(?:utility|internet|phone|electricity|gas|water) bill|address (?:check|verification|proof)|proof of (?:residence|address)|verify (?:my )?(?:address|identity|id)|(?:id|identity) verification|documents? (?:rejected|declined|pending)|upload(?:ed|ing)? (?:my )?(?:documents?|id|passport))\b/;
const RG_EXTRA_RE =
  /\b(?:block|exclude|restrict|lock|close|disable)\s+(?:me\s+from\s+|myself\s+from\s+)?(?:only\s+)?(?:the\s+)?(?:casino|sports?|sportsbook|poker)(?:\s+(?:part|section|side|products?))?\b|\b(?:lock|block|close|freeze|suspend)\s+(?:my\s+)?(?:account|acc)\s+(?:for\s+(?:good|a\s+(?:week|month|while|year)|\d+\s+\w+)|permanently|temporarily)|\b(?:need|want)\s+a\s+break\b|\b(?:exclude|block|ban|lock)\s+myself\b|\bi\s+think\s+i\s+(?:have|got)\s+a\s+(?:gambling\s+)?problem\b|\b(?:stop|quit)\s+(?:gambling|betting|playing)\b|\bself[- ]?exclu\w*/;
const TECH_EXTRA_RE =
  /\b(?:(?:wifi|wi-fi|internet|connection) (?:cut out|dropped|died|went down|disconnected|lost)|(?:lost|lose) (?:my )?(?:connection|internet|wifi)|disconnected|kicked out|logged me out|page (?:won't|doesn't|does not) load|keeps? (?:crashing|freezing|loading)|error (?:code|message)|says error|(?:can't|cannot|unable to|not able to|couldn't) (?:access|open|reach|load) (?:the |your )?(?:site|website|page|app|stake)|buffer(?:ing|s)?)\b/;
const AFFILIATE_EXTRA_RE =
  /\b(?:my own (?:referral |affiliate |promo )?code|(?:telegram|discord|youtube|twitch|kick) (?:channel|community|stream|server)|streamers?|influencers?|commission rate|rev(?:enue)? ?share|sub[- ]?affiliates?|(?:friend|buddy|mate|streamer)'?s? (?:link|code|referral)|referral link)\b/;
const SECURITY_EXTRA_RE =
  /\b(?:someone (?:else )?(?:accessed|used|logged into|got into|has access to)|not me|i didn't (?:make|do|authorize|place) (?:this|these|that|those)|(?:stolen|stole) (?:my )?(?:account|funds|crypto|balance)|account (?:was )?(?:stolen|taken over))\b/;
const SPORTS_EXTRA_RE =
  /\b(?:(?:\d+|one|two|three|four|five)[- ]legs?|legs? (?:won|lost|void|voided|won't|didn't)|football|soccer|nba|nfl|nhl|mlb|ufc|mma|tennis|basketball|baseball|hockey|cricket|esports?|e-sports?|cs2|csgo|dota|valorant|league of legends|premier league|champions league|la liga|serie a|bundesliga|world cup|formula 1|f1|boxing|rugby|golf|horse racing|goals?|scored|half ?time|full time|kick-?off|fixture|player props?|prop bets?)\b/;
const GAME_FREEZE_RE =
  /\b(?:game|slot|spin|round|bonus round|table|stream|live game)\b[^.!?]{0,30}\b(?:froze|frozen|freez(?:e|es|ing)|stuck|crash(?:ed)?|disconnect(?:ed)?|not loading|won't load|lag(?:ging)?|black screen|kicked)\b|\b(?:froze|frozen|freez(?:e|es|ing)|stuck|crash(?:ed)?|disconnect(?:ed)?)\b[^.!?]{0,20}\b(?:game|slot|spin|round|mid[- ]?spin|mid[- ]?round)\b/;
const BET_LIMIT_EXTRA_RE =
  /\b(?:(?:limited|restricted|capped|reduced) (?:my )?(?:account|bets?|stakes?|betting|max(?:imum)? bet)|(?:account|bets?|stakes?) (?:is |are |got |was |were |been )*(?:limited|restricted|capped|reduced)|max(?:imum)? stake|min(?:imum)? (?:bet|stake|wager)s?|why can't i bet more|bet (?:more|higher) than)\b/;
const BET_WORD_RE = /\b(?:bets?|betting|wager)\b/;
const COMPLAINT_STRONG_RE =
  /\b(?:(?:file|make|submit|raise|lodge|open) (?:a |an )?(?:formal )?complaint|formal complaint|escalate|speak to (?:a |your )?(?:manager|supervisor))\b/;
const ACCUSATION_RE = /\b(?:scam|scammers?|scammed|thie(?:f|ves)|stealing|rigged|fraud|liars?|rip ?off|ripped off)\b/;
const ANGRY_HINT_RE = /\b(?:fuck\w*|shit\w*|wtf|disgusting|pathetic|joke)\b/;

const BONUS_TERM_WEIGHTS: Record<string, number> = { offer: 0.8, drop: 0.6, code: 0.6, reward: 1.4, rewards: 1.4 };
/** With login/2FA wording, "code" is a verification code, not a bonus code. */
const BONUS_TERM_WEIGHTS_ACCESS: Record<string, number> = { ...BONUS_TERM_WEIGHTS, code: 0 };
const VIP_TERM_WEIGHTS: Record<string, number> = {
  rank: 1.4,
  tier: 1.4,
  'account manager': 1.4,
  host: 0.8,
  bronze: 1.0,
  silver: 1.0,
  gold: 1.0,
  platinum: 1.0,
  diamond: 1.0,
  obsidian: 1.0,
  opal: 1.0,
};
const KYC_TERM_WEIGHTS: Record<string, number> = { document: 1.6, documents: 1.6, verify: 2.2, verified: 2.2, verifying: 2.2, verification: 2.2 };
/** "verify" in a login/2FA or game-fairness context is weak KYC evidence. */
const KYC_TERM_WEIGHTS_OTHER_VERIFY: Record<string, number> = { ...KYC_TERM_WEIGHTS, verify: 0.5, verified: 0.5, verifying: 0.5, verification: 0.5 };
const ACCESS_TERM_WEIGHTS: Record<string, number> = { password: 1.8, otp: 2.0, 'email access': 2.0, passkey: 2.0, passkeys: 2.0, 'logged out': 1.8 };
const SECURITY_TERM_WEIGHTS: Record<string, number> = {
  vault: 1.4,
  'stake shield': 0.3,
  shield: 0.6,
  'mirror site': 1.4,
  mirror: 1.2,
  oauth: 1.4,
  security: 1.4,
};
const RG_TERM_WEIGHTS: Record<string, number> = { 'time out': 1.2, timeout: 1.2, 'block me': 2.0, 'take a break': 2.0 };
const SPORTS_TERM_WEIGHTS: Record<string, number> = {
  multi: 0.8,
  match: 1.0,
  market: 0.9,
  totals: 0.9,
  odds: 1.6,
  settled: 1.8,
  settlement: 1.8,
  void: 1.4,
  voided: 1.8,
  'game result': 1.5,
  sport: 1.8,
};
const CASINO_TERM_WEIGHTS: Record<string, number> = { game: 0.8, games: 0.8, spin: 0.9, spins: 0.9, crash: 1.0, provider: 1.6, seed: 1.2 };
const TECH_TERM_WEIGHTS: Record<string, number> = {
  loading: 1.0,
  connection: 1.0,
  cache: 0.9,
  cookies: 0.9,
  browser: 0.9,
  app: 0.6,
  blocked: 0.9,
  vpn: 1.2,
  'restricted region': 1.6,
  crash: 1.6,
};
const AFFILIATE_TERM_WEIGHTS: Record<string, number> = { refer: 1.5, referred: 1.5, commission: 1.4, campaign: 0.9 };
const PAYMENT_TERM_WEIGHTS: Record<string, number> = { bank: 1.0, card: 1.6, swapped: 1.0, binance: 1.0 };
const WAGERING_TERM_WEIGHTS: Record<string, number> = {
  wager: 1.5,
  wagering: 1.5,
  wagered: 1.5,
  turnover: 1.5,
  'bet through': 1.5,
};
const BONUS_CONCEPTS = ['bonus', 'reload', 'weekly_bonus', 'monthly_bonus', 'rakeback', 'welcome_offer', 'birthday'] as const;
const RG_TIMEOUT_TERMS = new Set(['time out', 'timeout']);
const DEPOSIT_PAST_TERMS = new Set(['deposited', 'topped up', 'funded', 'transferred', 'sent funds', 'sent crypto']);
const CASHOUT_TERMS = new Set(['cashout', 'cash out', 'cash-out', 'cashed out']);

type Evidence = Map<Intent, number>;

/** Message-level signals shared by the evidence rules. */
interface Signals {
  p: Prepared;
  norm: string;
  withdrawal: boolean;
  deposit: boolean;
  pending: boolean;
  missing: boolean;
  limit: boolean;
  how: boolean;
  elapsed: boolean;
  whenAsk: boolean;
  txHash: boolean;
  bonus: boolean;
  /** "cash out" refers to a sports bet cashout, not a withdrawal. */
  sportsCashout: boolean;
  /** Login/2FA verification wording ("verification code", "verify my email"). */
  accessVerify: boolean;
  /** Asks whether an email/message/link is genuine. */
  phishing: boolean;
  rg: RgRisk;
}

function addTo(ev: Evidence, intent: Intent, weight: number): void {
  if (weight > 0) ev.set(intent, (ev.get(intent) ?? 0) + weight);
}

function collectSignals(p: Prepared, rg: RgRisk): Signals {
  const norm = p.norm;
  const sportsCashout = isSportsCashout(p);
  return {
    p,
    norm,
    withdrawal: has(p, 'withdrawal') && !sportsCashout,
    deposit: has(p, 'deposit') || DEPOSIT_EXTRA_RE.test(norm),
    pending: has(p, 'pending') || PENDING_EXTRA_RE.test(norm),
    missing: mentionsMissingFunds(p, rg),
    limit: has(p, 'limit'),
    how: HOW_RE.test(norm),
    elapsed: ELAPSED_RE.test(norm),
    whenAsk: WHEN_RE.test(norm),
    txHash: has(p, 'tx_hash') || TX_HASH_TEST_RE.test(p.raw),
    bonus: BONUS_CONCEPTS.some((c) => has(p, c)) && !onlyReloadPage(p),
    sportsCashout,
    accessVerify: ACCESS_VERIFY_RE.test(norm),
    phishing: PHISHING_RE.test(norm),
    rg,
  };
}

function isSportsCashout(p: Prepared): boolean {
  const terms = termsOf(p, 'withdrawal');
  if (!terms.length || !terms.every((t) => CASHOUT_TERMS.has(t)) || WITHDRAWAL_MONEY_RE.test(p.norm)) return false;
  return has(p, 'sports') || SPORTS_CASHOUT_RE.test(p.norm) || BET_WORD_RE.test(p.norm);
}

/** "lost" counts as missing funds only outside gambling-loss wording ("lost on a bet", RG risk). */
function mentionsMissingFunds(p: Prepared, rg: RgRisk): boolean {
  if (MISSING_EXTRA_RE.test(p.norm)) return true;
  const terms = termsOf(p, 'missing');
  if (terms.some((t) => t !== 'lost')) return true;
  if (!terms.length || rg.risk || has(p, 'casino') || has(p, 'sports')) return false;
  return !GAMBLING_LOSS_RE.test(p.norm);
}

function onlyReloadPage(p: Prepared): boolean {
  return RELOAD_PAGE_RE.test(p.norm) && BONUS_CONCEPTS.every((c) => c === 'reload' || !has(p, c));
}

function addWithdrawalEvidence(s: Signals, ev: Evidence): void {
  if (!s.withdrawal) return;
  let pending = 0;
  if (s.pending) pending += 2.5;
  if (s.missing) pending += s.pending ? 0.5 : 2.5;
  if (s.elapsed) pending += pending ? 1.0 : 1.6;
  else if (s.whenAsk && !pending) pending += 0.8;
  if (s.txHash) pending += 0.3;
  addTo(ev, 'withdrawal_pending', pending);

  if (s.limit) addTo(ev, 'withdrawal_limits', 2.5);

  const busy = pending >= 2.5 || s.limit;
  if (s.how) addTo(ev, 'withdrawal_help', busy ? 1.0 : 2.2);
  else addTo(ev, 'withdrawal_help', busy ? 0.3 : 1.4);
  if (FEE_RE.test(s.norm)) addTo(ev, 'withdrawal_help', 1.0);
  if (WITHDRAW_BONUS_RE.test(s.norm) || WAGER_BEFORE_WITHDRAW_RE.test(s.norm)) addTo(ev, 'wagering_requirement', 1.2);
}

function addDepositEvidence(s: Signals, ev: Evidence): void {
  const net =
    (has(s.p, 'network') && WRONG_NETWORK_RE.test(s.norm)) ||
    (has(s.p, 'crypto') && (WRONG_NETWORK_RE.test(s.norm) || MISTAKEN_SEND_RE.test(s.norm)));
  if (s.deposit) {
    let missing = 0;
    if (s.missing) missing += 2.5;
    if (s.pending) missing += missing ? 0.5 : 2.0;
    if (s.elapsed && !s.how) missing += 1.0;
    if (s.txHash) missing += 1.0;
    if (net) missing += 2.5;
    addTo(ev, 'deposit_missing', missing);
    const busy = missing >= 2;
    const help = s.how ? (busy ? 1.0 : 2.2) : busy ? 0.3 : 1.4;
    addTo(ev, 'deposit_help', depositIsBackground(s) ? help * 0.4 : help);
    if (s.limit) addTo(ev, 'deposit_help', 0.8);
    if (!busy && DEPOSIT_ADDRESS_RE.test(s.norm)) addTo(ev, 'deposit_help', 0.6);
    if (FEE_RE.test(s.norm)) addTo(ev, 'deposit_help', 0.8);
    return;
  }
  if (s.withdrawal) return;
  const crypto = has(s.p, 'crypto') || s.txHash;
  if (s.txHash) addTo(ev, 'deposit_missing', 0.8);
  if (net) addTo(ev, 'deposit_missing', 2.0);
  if ((s.missing || s.pending) && crypto) {
    addTo(ev, 'deposit_missing', 1.2);
    addTo(ev, 'withdrawal_pending', 0.8);
  }
}

/** "...than the one I deposited": a past-tense deposit next to a withdrawal is context, not the question. */
function depositIsBackground(s: Signals): boolean {
  return s.withdrawal && termsOf(s.p, 'deposit').every((t) => DEPOSIT_PAST_TERMS.has(t));
}

function addPaymentEvidence(s: Signals, ev: Evidence): void {
  const fiat = conceptWeight(s.p, 'fiat', 2.2, PAYMENT_TERM_WEIGHTS);
  const moneyIssue = (s.deposit || s.withdrawal) && (s.missing || s.pending);
  addTo(ev, 'payment_methods', moneyIssue ? fiat * 0.5 : fiat);
  if (PAYMENT_EXTRA_RE.test(s.norm)) addTo(ev, 'payment_methods', 2.0);
}

function addBonusEvidence(s: Signals, ev: Evidence): void {
  const p = s.p;
  const weights = [
    conceptWeight(p, 'bonus', 2.2, has(p, 'access') || s.accessVerify ? BONUS_TERM_WEIGHTS_ACCESS : BONUS_TERM_WEIGHTS),
    RELOAD_PAGE_RE.test(s.norm) ? 0 : conceptWeight(p, 'reload', 2.2),
    conceptWeight(p, 'weekly_bonus', 2.2, { weekly: 0.9 }),
    conceptWeight(p, 'monthly_bonus', 2.2, { monthly: 0.9 }),
    conceptWeight(p, 'rakeback', 2.2, { rake: 1.2 }),
    conceptWeight(p, 'welcome_offer', 2.2),
    conceptWeight(p, 'birthday', 1.6),
  ].filter((w) => w > 0);
  if (weights.length) addTo(ev, 'bonus_inquiry', Math.max(...weights) + Math.min(0.9, 0.3 * (weights.length - 1)));
  if (RELOAD_PAGE_RE.test(s.norm)) addTo(ev, 'technical_issue', 0.8);

  const wagering = conceptWeight(p, 'wagering', 2.6, WAGERING_TERM_WEIGHTS);
  if (wagering) addTo(ev, 'wagering_requirement', wagering + (s.bonus ? 0.8 : 0));
  if (WAGERING_EXTRA_RE.test(s.norm)) addTo(ev, 'wagering_requirement', 2.0);
}

function addVipAndKycEvidence(s: Signals, ev: Evidence): void {
  addTo(ev, 'vip_program', conceptWeight(s.p, 'vip', 2.2, VIP_TERM_WEIGHTS));
  const otherVerify = s.accessVerify || s.phishing || FAIRNESS_VERIFY_RE.test(s.norm);
  addTo(ev, 'kyc_verification', conceptWeight(s.p, 'kyc', 2.5, otherVerify ? KYC_TERM_WEIGHTS_OTHER_VERIFY : KYC_TERM_WEIGHTS));
  if (KYC_EXTRA_RE.test(s.norm)) addTo(ev, 'kyc_verification', 2.2);
}

function addAccountEvidence(s: Signals, ev: Evidence): void {
  const p = s.p;
  const twoFaSetup = TWO_FA_SETUP_RE.test(s.norm);
  addTo(ev, 'account_access', conceptWeight(p, 'access', 2.5, ACCESS_TERM_WEIGHTS));
  if (ACCESS_EXTRA_RE.test(s.norm)) addTo(ev, 'account_access', 2.0);
  else if (s.accessVerify && !twoFaSetup) addTo(ev, 'account_access', 1.0);
  if (termsOf(p, 'account').some((t) => t !== 'account')) addTo(ev, 'account_access', 0.8);

  addTo(ev, 'account_security', conceptWeight(p, 'security', 2.5, SECURITY_TERM_WEIGHTS));
  if (SECURITY_EXTRA_RE.test(s.norm)) addTo(ev, 'account_security', 2.0);
  if (twoFaSetup) addTo(ev, 'account_security', 3.0);
  if (s.phishing) addTo(ev, 'account_security', 2.5);

  if (has(p, 'closure') || CLOSURE_EXTRA_RE.test(s.norm)) addTo(ev, 'account_closure', 3.0);
}

function addResponsibleGamblingEvidence(s: Signals, ev: Evidence): void {
  const p = s.p;
  const timeoutOnly = termsOf(p, 'responsible_gambling').every((t) => RG_TIMEOUT_TERMS.has(t));
  const technicalTimeout = timeoutOnly && has(p, 'technical');
  addTo(ev, 'responsible_gambling', technicalTimeout ? 0.3 : conceptWeight(p, 'responsible_gambling', 3.0, RG_TERM_WEIGHTS));
  if (s.rg.risk || RG_EXTRA_RE.test(s.norm)) addTo(ev, 'responsible_gambling', 3.0);
  if (s.rg.critical) addTo(ev, 'responsible_gambling', 1.5);
}

function addProductEvidence(s: Signals, ev: Evidence): void {
  const p = s.p;
  addTo(ev, 'sports_betting', conceptWeight(p, 'sports', 2.0, SPORTS_TERM_WEIGHTS));
  if (SPORTS_EXTRA_RE.test(s.norm)) addTo(ev, 'sports_betting', 1.4);
  if (s.sportsCashout || termsOf(p, 'security').includes('stake shield')) addTo(ev, 'sports_betting', 2.0);
  if (has(p, 'bet_id')) {
    addTo(ev, 'sports_betting', 0.9);
    addTo(ev, 'casino_games', 0.6);
  }

  addTo(ev, 'casino_games', conceptWeight(p, 'casino', 2.0, CASINO_TERM_WEIGHTS));
  if (PROVIDER_TEST_RE.test(p.raw) || GAME_TEST_RE.test(p.raw)) addTo(ev, 'casino_games', 1.0);
  if (GAME_FREEZE_RE.test(s.norm)) {
    addTo(ev, 'casino_games', 1.5);
    addTo(ev, 'technical_issue', 2.2);
  }

  addTo(ev, 'betting_limits', conceptWeight(p, 'bet_limits', 2.6));
  if (BET_LIMIT_EXTRA_RE.test(s.norm)) addTo(ev, 'betting_limits', 2.2);
  const productContext = has(p, 'sports') || has(p, 'casino') || BET_WORD_RE.test(s.norm);
  if (s.limit && productContext && !s.withdrawal && !s.deposit) addTo(ev, 'betting_limits', 1.0);

  addTo(ev, 'technical_issue', conceptWeight(p, 'technical', 2.0, TECH_TERM_WEIGHTS));
  if (TECH_EXTRA_RE.test(s.norm)) addTo(ev, 'technical_issue', 2.5);
  addTo(ev, 'affiliate', conceptWeight(p, 'affiliate', 2.5, AFFILIATE_TERM_WEIGHTS));
  if (AFFILIATE_EXTRA_RE.test(s.norm)) addTo(ev, 'affiliate', 2.5);
}

/** Complaint is usually secondary: damped when another intent already has solid evidence. */
function addComplaintEvidence(s: Signals, ev: Evidence): void {
  let raw = conceptWeight(s.p, 'complaint', 1.2);
  if (raw) raw += 0.15 * Math.max(0, termsOf(s.p, 'complaint').length - 1);
  if (ACCUSATION_RE.test(s.norm)) raw += 1.5;
  else if (ANGRY_HINT_RE.test(s.norm)) raw += 0.8;
  if (COMPLAINT_STRONG_RE.test(s.norm)) raw += 2.0;
  if (!raw) return;
  const strongOther = [...ev.values()].some((w) => w >= 2);
  addTo(ev, 'complaint', strongOther ? raw * 0.7 : raw);
}

const EVIDENCE_RULES: readonly ((s: Signals, ev: Evidence) => void)[] = [
  addWithdrawalEvidence,
  addDepositEvidence,
  addPaymentEvidence,
  addBonusEvidence,
  addVipAndKycEvidence,
  addAccountEvidence,
  addResponsibleGamblingEvidence,
  addProductEvidence,
  addComplaintEvidence,
];

const INTENT_ORDER = new Map<Intent, number>(INTENTS.map((intent, i) => [intent, i]));

/** Raw (unsaturated) evidence per intent. */
function intentEvidence(p: Prepared, rg: RgRisk = detectRgRiskNorm(p.norm)): Evidence {
  const signals = collectSignals(p, rg);
  const ev: Evidence = new Map();
  for (const rule of EVIDENCE_RULES) rule(signals, ev);
  return ev;
}

/** Score intents of a prepared message (see scoreIntents). */
export function scoreIntentsPrepared(p: Prepared, rg?: RgRisk): IntentScore[] {
  if (!p.norm) return [];
  const scored: IntentScore[] = [];
  for (const [intent, raw] of intentEvidence(p, rg)) {
    const score = round2(1 - Math.exp(-raw / SATURATION_K));
    if (score >= MIN_INTENT_SCORE) scored.push({ intent, score });
  }
  if (!scored.length) return [{ intent: 'general', score: GENERAL_FALLBACK_SCORE }];
  scored.sort((a, b) => b.score - a.score || (INTENT_ORDER.get(a.intent) ?? 0) - (INTENT_ORDER.get(b.intent) ?? 0));
  return scored.slice(0, MAX_INTENTS);
}

/**
 * Intent scores (0..1), sorted desc, max 3, only intents with score >= 0.15. Non-empty text without evidence
 * falls back to [{ intent: 'general', score: 0.3 }]; empty text returns [].
 */
export function scoreIntents(text: string): IntentScore[] {
  return scoreIntentsPrepared(prepare(text));
}
