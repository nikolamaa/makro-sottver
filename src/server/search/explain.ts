/**
 * Deterministic one-sentence explanations for recommendations, e.g.
 * "Matches the pending withdrawal question (pending, BTC) and the macro is verified."
 * "Matches the betting limits question (max bet, limit), but it is about casino, not sports."
 */
import { INTENT_LABELS, type Intent, type ScoreBreakdown, type VerificationStatus } from '../../shared/types.js';
import type { Product } from '../domain/igaming.js';

export const MAX_REASON_LENGTH = 160;
const MAX_REASON_TERMS = 3;

/** Short tokens shown upper-case in explanations (tickers, acronyms). */
const UPPERCASE_TERMS: ReadonlySet<string> = new Set(
  'btc eth ltc usdt usdc trx xrp doge sol bch bnb ada eos dai shib busd kyc vip 2fa otp id usd eur gbp inr cad erc20 trc20 bep20 vpn'.split(' '),
);

/** Display form of a matched term ("btc" -> "BTC"). */
export function displayTerm(term: string): string {
  return UPPERCASE_TERMS.has(term) ? term.toUpperCase() : term;
}

/** "Pending withdrawal" -> "pending withdrawal", but "VIP program" stays as is. */
function intentPhrase(intent: Intent): string {
  const label = INTENT_LABELS[intent];
  const second = label.charAt(1);
  return second && second === second.toLowerCase() ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface ReasonInput {
  coversIntents: readonly Intent[];
  /** Customer intent matched only through a related macro intent. */
  relatedIntent: Intent | null;
  matchedTerms: readonly string[];
  breakdown: ScoreBreakdown;
  verification: VerificationStatus;
  hasFacts: boolean;
  /** Why the macro may not answer the message although it matches (lowers confidence; named in the reason). */
  caveat?: ReasonCaveat | null;
}

/**
 * - resolved: the macro is about a missing/pending money flow that the customer says already arrived;
 * - product: the macro is specific to another product than the one the customer names.
 */
export type ReasonCaveat = { kind: 'resolved'; flow: 'deposit' | 'withdrawal' } | { kind: 'product'; asked: readonly Product[]; macro: readonly Product[] };

function joinWithOr(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/** Caveat clause without connector, e.g. "it is about casino, not sports". */
function caveatText(caveat: ReasonCaveat): string {
  switch (caveat.kind) {
    case 'resolved':
      return `the customer says the ${caveat.flow} already arrived`;
    case 'product':
      return `it is about ${joinWithAnd([...caveat.macro])}, not ${joinWithOr(caveat.asked)}`;
  }
}

function mainClause(input: ReasonInput): string {
  const { coversIntents, relatedIntent, breakdown } = input;
  if (coversIntents.length === 1) return `Matches the ${intentPhrase(coversIntents[0]!)} question`;
  if (coversIntents.length > 1) return `Covers the ${joinWithAnd(coversIntents.slice(0, 3).map(intentPhrase))} questions`;
  if (relatedIntent) return `Related to the ${intentPhrase(relatedIntent)} question`;
  if (breakdown.lexical >= 0.5 && breakdown.lexical >= breakdown.semantic) return 'Shares key terms with the message';
  if (breakdown.semantic >= 0.5) return 'Similar in meaning to the message';
  return 'Closest available macro, but only loosely related';
}

function verificationClause(verification: VerificationStatus, hasFacts: boolean): string {
  switch (verification) {
    case 'verified':
      return ' and the macro is verified.';
    case 'outdated':
      return ', but some of its facts are outdated.';
    case 'conflict':
      return ', but one of its facts conflicts with the source.';
    case 'unverified':
      return hasFacts ? '; its facts are not verified yet.' : '.';
  }
}

/** Verification tail after a caveat: "verified" is no longer worth a clause, warnings still are. */
function caveatTail(verification: VerificationStatus, hasFacts: boolean): string {
  switch (verification) {
    case 'verified':
      return '.';
    case 'outdated':
      return '; some of its facts are outdated.';
    case 'conflict':
      return '; one of its facts conflicts with the source.';
    case 'unverified':
      return hasFacts ? '; its facts are not verified yet.' : '.';
  }
}

/**
 * One deterministic sentence (<= 160 chars) explaining why a macro was recommended. When it is too long, matched
 * terms are dropped first, then the caveat.
 */
export function buildReason(input: ReasonInput): string {
  const main = mainClause(input);
  const terms = input.matchedTerms.slice(0, MAX_REASON_TERMS);
  const caveat = input.caveat ?? null;
  const connector = main.includes(' but ') ? '; ' : ', but ';
  for (const withCaveat of caveat ? [`${connector}${caveatText(caveat)}`, ''] : ['']) {
    const tail = withCaveat ? caveatTail(input.verification, input.hasFacts) : verificationClause(input.verification, input.hasFacts);
    for (let n = terms.length; n >= 0; n--) {
      const withTerms = n > 0 ? `${main} (${terms.slice(0, n).join(', ')})` : main;
      const sentence = `${withTerms}${withCaveat}${tail}`;
      if (sentence.length <= MAX_REASON_LENGTH) return sentence;
    }
  }
  return `${main}${verificationClause(input.verification, input.hasFacts)}`.slice(0, MAX_REASON_LENGTH);
}
