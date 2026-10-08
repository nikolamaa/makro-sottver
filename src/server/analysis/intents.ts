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
  /\b(?:\d+|an?|one|two|three|four|five|few|couple(?: of)?|several|many)\s*(?:hours?|hrs?|days?|weeks?|months?|mins?|minutes?)\b|\b\d+\s*[hd]\b|\b(?:ago|since|yesterday|last (?:night|week|month)|for (?:hours|days|weeks|ages|so long|a while|a long time)|all day|forever|ages)\b/;
const WHEN_RE = /\b(?:when|how long|eta|by when)\b/;
const PENDING_EXTRA_RE =
  /\b(?:still (?:not|no|haven't|hasn't|waiting|pending)|taking (?:forever|ages|too long)|waiting|awaiting|in progress|not (?:yet )?(?:approved|processed|confirmed|completed)|status of)\b/;
const MISSING_EXTRA_RE =
  /\b(?:didn't (?:get|receive)|did not (?:get|receive)|haven't (?:got|gotten|received)|never (?:got|received|came)|not (?:in|on) my (?:wallet|balance|account)|balance (?:is |shows )?(?:still )?(?:0|zero|empty)|still (?:0|zero|empty)|nothing (?:arrived|came|showed up|shows up|appeared)|(?:didn't|did not|doesn't|does not|hasn't|has not|not) (?:show|showed|shown|showing|appear|appeared) up|where (?:is|are) (?:my|the) (?:money|funds|crypto|coins?))\b/;
const GAMBLING_LOSS_RE = /\blost (?:on|at|in|playing|betting|gambling|it all|everything|a bet|my bets?)\b/;
const WRONG_NETWORK_RE =
  /\b(?:wrong|different|incorrect|unsupported) (?:network|chain|blockchain|address|coin|currency|token|memo|tag)\b|\b(?:forgot|without|missing|no) (?:the )?(?:memo|tag|destination tag)\b/;
const DEPOSIT_EXTRA_RE = /\b(?:deposit address|my stake (?:wallet|address)|sent (?:it |them |the (?:money|funds|coins?|crypto) )?to (?:my )?stake)\b/;
const FEE_RE = /\bfees?\b/;
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
  /\b(?:(?:can't|cannot|unable to|not able to|couldn't) (?:access|get into|open) (?:my )?account|code (?:not|never) (?:received|arriving|coming)|(?:didn't|did not|don't|haven't) (?:get|receive) (?:the |a |any )?(?:code|email|sms)|change (?:my )?(?:email|phone|password)|reset (?:my )?(?:2fa|password)|disable 2fa|account(?: \S+)? (?:is |was |got |has been |been )?(?:locked|disabled|suspended|frozen|banned|deactivated)|locked (?:my )?account)\b/;
const SECURITY_EXTRA_RE =
  /\b(?:someone (?:else )?(?:accessed|used|logged into|got into|has access to)|not me|i didn't (?:make|do|authorize|place) (?:this|these|that|those)|(?:stolen|stole) (?:my )?(?:account|funds|crypto|balance)|account (?:was )?(?:stolen|taken over))\b/;
const SPORTS_EXTRA_RE =
  /\b(?:football|soccer|nba|nfl|nhl|mlb|ufc|mma|tennis|basketball|baseball|hockey|cricket|esports?|e-sports?|cs2|csgo|dota|valorant|league of legends|premier league|champions league|la liga|serie a|bundesliga|world cup|formula 1|f1|boxing|rugby|golf|horse racing|goals?|scored|half ?time|full time|kick-?off|fixture|player props?|prop bets?)\b/;
const GAME_FREEZE_RE =
  /\b(?:game|slot|spin|round|bonus round|table|stream|live game)\b[^.!?]{0,30}\b(?:froze|frozen|freez(?:e|es|ing)|stuck|crash(?:ed)?|disconnect(?:ed)?|not loading|won't load|lag(?:ging)?|black screen|kicked)\b|\b(?:froze|frozen|freez(?:e|es|ing)|stuck|crash(?:ed)?|disconnect(?:ed)?)\b[^.!?]{0,20}\b(?:game|slot|spin|round|mid[- ]?spin|mid[- ]?round)\b/;
const BET_LIMIT_EXTRA_RE =
  /\b(?:(?:limited|restricted|capped|reduced) (?:my )?(?:account|bets?|stakes?|betting|max(?:imum)? bet)|(?:account|bets?|stakes?) (?:is |are |got |was |were |been )*(?:limited|restricted|capped|reduced)|max(?:imum)? stake|why can't i bet more|bet (?:more|higher) than)\b/;
const BET_WORD_RE = /\b(?:bets?|betting|wager)\b/;
const COMPLAINT_STRONG_RE =
  /\b(?:(?:file|make|submit|raise|lodge|open) (?:a |an )?(?:formal )?complaint|formal complaint|escalate|speak to (?:a |your )?(?:manager|supervisor))\b/;
const ANGRY_HINT_RE = /\b(?:scam|scammers?|thie(?:f|ves)|stealing|rigged|fraud|liars?|fuck\w*|shit\w*|wtf|disgusting|pathetic)\b|!{3,}/;

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
  'stake shield': 1.0,
  shield: 1.0,
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
  rg: RgRisk;
}

function addTo(ev: Evidence, intent: Intent, weight: number): void {
  if (weight > 0) ev.set(intent, (ev.get(intent) ?? 0) + weight);
}

function collectSignals(p: Prepared, rg: RgRisk): Signals {
  const norm = p.norm;
  return {
    p,
    norm,
    withdrawal: has(p, 'withdrawal'),
    deposit: has(p, 'deposit') || DEPOSIT_EXTRA_RE.test(norm),
    pending: has(p, 'pending') || PENDING_EXTRA_RE.test(norm),
    missing: mentionsMissingFunds(p, rg),
    limit: has(p, 'limit'),
    how: HOW_RE.test(norm),
    elapsed: ELAPSED_RE.test(norm),
    whenAsk: WHEN_RE.test(norm),
    txHash: has(p, 'tx_hash') || TX_HASH_TEST_RE.test(p.raw),
    bonus: BONUS_CONCEPTS.some((c) => has(p, c)) && !onlyReloadPage(p),
    rg,
  };
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
  if (WITHDRAW_BONUS_RE.test(s.norm)) addTo(ev, 'wagering_requirement', 1.2);
}

function addDepositEvidence(s: Signals, ev: Evidence): void {
  const net = has(s.p, 'network') && WRONG_NETWORK_RE.test(s.norm);
  if (s.deposit) {
    let missing = 0;
    if (s.missing) missing += 2.5;
    if (s.pending) missing += missing ? 0.5 : 2.0;
    if (s.elapsed && !s.how) missing += 1.0;
    if (s.txHash) missing += 1.0;
    if (net) missing += 1.2;
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
  if (net) addTo(ev, 'deposit_missing', 1.2);
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
  addTo(ev, 'payment_methods', conceptWeight(s.p, 'fiat', 2.2, PAYMENT_TERM_WEIGHTS));
  if (PAYMENT_EXTRA_RE.test(s.norm)) addTo(ev, 'payment_methods', 2.0);
}

function addBonusEvidence(s: Signals, ev: Evidence): void {
  const p = s.p;
  const weights = [
    conceptWeight(p, 'bonus', 2.2, has(p, 'access') ? BONUS_TERM_WEIGHTS_ACCESS : BONUS_TERM_WEIGHTS),
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
}

function addAccountEvidence(s: Signals, ev: Evidence): void {
  const p = s.p;
  addTo(ev, 'vip_program', conceptWeight(p, 'vip', 2.2, VIP_TERM_WEIGHTS));

  const accessVerify = ACCESS_VERIFY_RE.test(s.norm);
  const otherVerify = accessVerify || FAIRNESS_VERIFY_RE.test(s.norm);
  addTo(ev, 'kyc_verification', conceptWeight(p, 'kyc', 2.5, otherVerify ? KYC_TERM_WEIGHTS_OTHER_VERIFY : KYC_TERM_WEIGHTS));

  addTo(ev, 'account_access', conceptWeight(p, 'access', 2.5, ACCESS_TERM_WEIGHTS));
  if (ACCESS_EXTRA_RE.test(s.norm)) addTo(ev, 'account_access', 2.0);
  else if (accessVerify) addTo(ev, 'account_access', 1.0);
  if (termsOf(p, 'account').some((t) => t !== 'account')) addTo(ev, 'account_access', 0.8);

  addTo(ev, 'account_security', conceptWeight(p, 'security', 2.5, SECURITY_TERM_WEIGHTS));
  if (SECURITY_EXTRA_RE.test(s.norm)) addTo(ev, 'account_security', 2.0);

  if (has(p, 'closure')) addTo(ev, 'account_closure', 3.0);
}

function addResponsibleGamblingEvidence(s: Signals, ev: Evidence): void {
  const p = s.p;
  const timeoutOnly = termsOf(p, 'responsible_gambling').every((t) => RG_TIMEOUT_TERMS.has(t));
  const technicalTimeout = timeoutOnly && has(p, 'technical');
  addTo(ev, 'responsible_gambling', technicalTimeout ? 0.3 : conceptWeight(p, 'responsible_gambling', 3.0, RG_TERM_WEIGHTS));
  if (s.rg.risk) addTo(ev, 'responsible_gambling', 3.0);
  if (s.rg.critical) addTo(ev, 'responsible_gambling', 1.5);
}

function addProductEvidence(s: Signals, ev: Evidence): void {
  const p = s.p;
  addTo(ev, 'sports_betting', conceptWeight(p, 'sports', 2.0, SPORTS_TERM_WEIGHTS));
  if (SPORTS_EXTRA_RE.test(s.norm)) addTo(ev, 'sports_betting', 1.4);

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
  addTo(ev, 'affiliate', conceptWeight(p, 'affiliate', 2.5, AFFILIATE_TERM_WEIGHTS));
}

/** Complaint is usually secondary: damped when another intent already has solid evidence. */
function addComplaintEvidence(s: Signals, ev: Evidence): void {
  let raw = conceptWeight(s.p, 'complaint', 1.2);
  if (raw) raw += 0.15 * Math.max(0, termsOf(s.p, 'complaint').length - 1);
  if (ANGRY_HINT_RE.test(s.norm)) raw += 0.8;
  if (COMPLAINT_STRONG_RE.test(s.norm)) raw += 2.0;
  if (!raw) return;
  const strongOther = [...ev.values()].some((w) => w >= 2);
  addTo(ev, 'complaint', strongOther ? raw * 0.6 : raw);
}

const EVIDENCE_RULES: readonly ((s: Signals, ev: Evidence) => void)[] = [
  addWithdrawalEvidence,
  addDepositEvidence,
  addPaymentEvidence,
  addBonusEvidence,
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
