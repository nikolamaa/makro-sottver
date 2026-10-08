/**
 * Urgency: critical (self-harm wording) > high (anger, threats, "urgent", long waits, large amounts, RG risk)
 * > low (positive message without an open issue) > normal.
 */
import type { Entity, IntentScore, Sentiment, Urgency } from '../../shared/types.js';
import { normalizeForMatch } from '../domain/igaming.js';
import { durationHours } from './entities.js';
import { scoreIntents } from './intents.js';

/** What detectUrgency needs besides the text (already computed by the other analyzer steps). */
export interface UrgencyContext {
  sentiment: Sentiment;
  entities: Entity[];
  rgCritical: boolean;
  /** Non-critical responsible-gambling risk; raises urgency to high when true. */
  rgRisk?: boolean;
  /** Precomputed intents (avoids re-scoring); computed from `text` when omitted. */
  intents?: IntentScore[];
}

const URGENT_RE = /\b(?:urgent(?:ly)?|asap|a\.s\.a\.p|emergency|immediately|right now|right away|as soon as possible)\b/;
const LEGAL_RE =
  /\b(?:lawyers?|attorney|legal action|take (?:legal )?action|sue|suing|court|regulators?|curacao|gaming (?:authority|commission)|licen[cs]e holder|report (?:you|this|stake)|police|authorities)\b/;
const CHARGEBACK_RE = /\b(?:chargeback|charge back|dispute (?:the|this|my) (?:payment|transaction|charge|deposit))\b/;
/** Waiting/missing wording shortly before a duration ("pending for 3 days", "not credited for 2 days"). */
const WAIT_BEFORE_RE =
  /\b(?:wait\w*|pending|stuck|delayed|on hold|processing|in review|under review|not (?:yet )?(?:arrived|received|credited|processed|approved|showing|shown|reflected|here|there|paid)|(?:haven't|have not|hasn't|has not|didn't|did not) (?:got|gotten|received|arrived|come)|no (?:response|reply|answer|update)s?|missing)\b[^.!?\n]{0,24}$/;
/** Elapsed-time wording before a duration ("it's been 3 days"); counts only when something is being waited on. */
const PAST_BEFORE_RE = /\b(?:it(?:'s| is| has)? been|since|already|for (?:the )?(?:last|past))\b[^.!?\n]{0,12}$/;
/** "3 days ago" */
const AGO_AFTER_RE = /^\s*(?:ago|back)\b/;
/** Something the customer is waiting on: a payment, a verification, a support answer. */
const PROCESS_RE =
  /\b(?:withdr\w*|cash ?out|cashed out|payout|deposit\w*|top[- ]?up|sent|transfer\w*|verif\w*|kyc|documents?|uploaded|submitted|request\w*|ticket|refund\w*|claim\w*|support|e-?mailed|contacted)\b/;
/** Unquantified long waits ("for days", "weeks now"); quantified ones go through the duration entities. */
const LONG_WAIT_WORDS_RE =
  /\b(?:for|since|over|been) (?:days|weeks|months|ages)\b|(?<!\b(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|few|couple(?: of)?|several|many) )\b(?:days|weeks|months) (?:now|already|ago)\b|\bwaiting (?:for )?(?:days|weeks|months)\b/;
/** How far before a duration the waiting wording may start. */
const WAIT_WINDOW = 40;
const MONEY_MOVE_RE = /\b(?:withdr\w*|cash ?out|cashed out|payout|deposit\w*|top[- ]?up|sent|transfer\w*)\b/;

const LONG_WAIT_HOURS = 24;
const LARGE_AMOUNT = 1000;

/** A wait of 24 hours or more: "pending for 3 days", "withdrew 2 days ago", "waiting for weeks". */
function longWait(text: string, norm: string, entities: Entity[]): boolean {
  if (LONG_WAIT_WORDS_RE.test(norm)) return true;
  const process = PROCESS_RE.test(norm);
  return entities.some((e) => {
    if (e.type !== 'duration' || (durationHours(e.value) ?? 0) < LONG_WAIT_HOURS) return false;
    const before = normalizeForMatch(text.slice(Math.max(0, e.start - WAIT_WINDOW), e.start));
    if (WAIT_BEFORE_RE.test(before)) return true;
    return process && (PAST_BEFORE_RE.test(before) || AGO_AFTER_RE.test(text.slice(e.end, e.end + 8)));
  });
}

function largeAmount(norm: string, entities: Entity[]): boolean {
  return MONEY_MOVE_RE.test(norm) && entities.some((e) => e.type === 'amount' && Number(e.value) >= LARGE_AMOUNT);
}

function highReasons(text: string, norm: string, ctx: UrgencyContext): string[] {
  const reasons: string[] = [];
  if (ctx.rgRisk) reasons.push('Responsible gambling risk');
  if (ctx.sentiment === 'angry') reasons.push('Customer is angry');
  if (LEGAL_RE.test(norm)) reasons.push('Legal or regulator threat');
  if (CHARGEBACK_RE.test(norm)) reasons.push('Chargeback threat');
  if (URGENT_RE.test(norm)) reasons.push('Customer says it is urgent');
  if (longWait(text, norm, ctx.entities)) reasons.push('Waiting 24 hours or longer');
  if (largeAmount(norm, ctx.entities)) reasons.push('Large amount (1,000+)');
  return reasons;
}

function isThanksOnly(text: string, intents: IntentScore[] | undefined): boolean {
  const scored = intents ?? scoreIntents(text);
  return scored.length === 0 || scored[0]?.intent === 'general';
}

/**
 * Urgency with short English reasons:
 *  critical if rgCritical; high if angry, legal/regulator/chargeback threats, 'urgent'/'asap'/'emergency',
 *  waiting >= 24h ("3 days", "for weeks"), or amounts >= 1000 with withdrawal/deposit context (or RG risk);
 *  low for positive general/thanks-only messages; else normal.
 */
export function detectUrgency(text: string, ctx: UrgencyContext): { urgency: Urgency; reasons: string[] } {
  if (ctx.rgCritical) return { urgency: 'critical', reasons: ['Possible self-harm risk: follow the wellbeing procedure'] };
  const norm = normalizeForMatch(text);
  const reasons = highReasons(text, norm, ctx);
  if (reasons.length) return { urgency: 'high', reasons };
  if (ctx.sentiment === 'positive' && isThanksOnly(text, ctx.intents)) {
    return { urgency: 'low', reasons: ['Positive message without an open issue'] };
  }
  return { urgency: 'normal', reasons: [] };
}
