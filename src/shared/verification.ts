import type { Fact, FactStatus, VerificationStatus } from './types.js';

/**
 * Roll fact statuses up to a macro-level verification status.
 * - any 'contradicted'  -> 'conflict'
 * - any 'outdated'      -> 'outdated'
 * - >=1 fact and all 'verified' -> 'verified'
 * - otherwise (no facts, unchecked, unverifiable) -> 'unverified'
 */
export function rollupVerification(statuses: FactStatus[]): VerificationStatus {
  if (statuses.includes('contradicted')) return 'conflict';
  if (statuses.includes('outdated')) return 'outdated';
  if (statuses.length > 0 && statuses.every((s) => s === 'verified')) return 'verified';
  return 'unverified';
}

/** Human-readable warnings shown next to a recommended macro. Empty when nothing to warn about. */
export function verificationWarnings(facts: Pick<Fact, 'status' | 'statement'>[]): string[] {
  const warnings: string[] = [];
  const contradicted = facts.filter((f) => f.status === 'contradicted');
  const outdated = facts.filter((f) => f.status === 'outdated');
  const unchecked = facts.filter((f) => f.status === 'unchecked' || f.status === 'unverifiable');
  if (contradicted.length) warnings.push(`${contradicted.length} fact(s) contradict the source: ${contradicted.map((f) => f.statement).join('; ')}`);
  if (outdated.length) warnings.push(`${outdated.length} fact(s) outdated: ${outdated.map((f) => f.statement).join('; ')}`);
  if (unchecked.length) warnings.push(`${unchecked.length} fact(s) not verified yet`);
  return warnings;
}
