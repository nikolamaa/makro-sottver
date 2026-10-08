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
const WAIT_CUE_RE =
  /\b(?:wait\w*|pending|since|ago|still|stuck|been|already|delayed|for (?:the )?(?:last|past)|not (?:yet )?(?:arrived|received|credited|processed|approved))\b/;
const LONG_WAIT_WORDS_RE =
  /\b(?:for|since|over) (?:days|weeks|months|ages)\b|\b(?:days|weeks|months) (?:now|already|ago)\b|\bwaiting (?:for )?(?:days|weeks|months)\b/;
const MONEY_MOVE_RE = /\b(?:withdr\w*|cash ?out|cashed out|payout|deposit\w*|top[- ]?up|sent|transfer\w*)\b/;

const LONG_WAIT_HOURS = 24;
const LARGE_AMOUNT = 1000;

function longWait(norm: string, entities: Entity[]): boolean {
  if (LONG_WAIT_WORDS_RE.test(norm)) return true;
  if (!WAIT_CUE_RE.test(norm)) return false;
  return entities.some((e) => e.type === 'duration' && (durationHours(e.value) ?? 0) >= LONG_WAIT_HOURS);
}

function largeAmount(norm: string, entities: Entity[]): boolean {
  return MONEY_MOVE_RE.test(norm) && entities.some((e) => e.type === 'amount' && Number(e.value) >= LARGE_AMOUNT);
}

function highReasons(norm: string, ctx: UrgencyContext): string[] {
  const reasons: string[] = [];
  if (ctx.rgRisk) reasons.push('Responsible gambling risk');
  if (ctx.sentiment === 'angry') reasons.push('Customer is angry');
  if (LEGAL_RE.test(norm)) reasons.push('Legal or regulator threat');
  if (CHARGEBACK_RE.test(norm)) reasons.push('Chargeback threat');
  if (URGENT_RE.test(norm)) reasons.push('Customer says it is urgent');
  if (longWait(norm, ctx.entities)) reasons.push('Waiting 24 hours or longer');
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
  const reasons = highReasons(norm, ctx);
  if (reasons.length) return { urgency: 'high', reasons };
  if (ctx.sentiment === 'positive' && isThanksOnly(text, ctx.intents)) {
    return { urgency: 'low', reasons: ['Positive message without an open issue'] };
  }
  return { urgency: 'normal', reasons: [] };
}
