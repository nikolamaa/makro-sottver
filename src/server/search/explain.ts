/**
 * Deterministic one-sentence explanations for recommendations, e.g.
 * "Matches the pending withdrawal question (pending, BTC) and the macro is verified."
 */
import { INTENT_LABELS, type Intent, type ScoreBreakdown, type VerificationStatus } from '../../shared/types.js';

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

/** One deterministic sentence (<= 160 chars) explaining why a macro was recommended. */
export function buildReason(input: ReasonInput): string {
  const main = mainClause(input);
  const tail = verificationClause(input.verification, input.hasFacts);
  const terms = input.matchedTerms.slice(0, MAX_REASON_TERMS);
  for (let n = terms.length; n >= 0; n--) {
    const withTerms = n > 0 ? `${main} (${terms.slice(0, n).join(', ')})${tail}` : `${main}${tail}`;
    if (withTerms.length <= MAX_REASON_LENGTH) return withTerms;
  }
  return `${main}${tail}`.slice(0, MAX_REASON_LENGTH);
}
