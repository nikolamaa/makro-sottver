/**
 * Template-variable helpers for the Assist page: which variables the selected macros use, which values were
 * detected in the customer message, and what the agent overrides. Pure functions only.
 */
import { listVariables } from '../../../shared/template';
import type { Entity, EntityType } from '../../../shared/types';

/**
 * Entity type -> standard template variable. Mirrors the server's variablesFromAnalysis so detected values
 * show instantly in the Variables panel. Policy values (eta_time, date, link, bonus_amount) are deliberately
 * absent: they must never be taken from customer text.
 */
const ENTITY_VARIABLE: Partial<Record<EntityType, string>> = {
  name: 'user',
  username: 'username',
  email: 'email',
  amount: 'amount',
  currency: 'currency',
  crypto: 'crypto',
  network: 'network',
  tx_hash: 'tx_hash',
  bet_id: 'bet_id',
  vip_rank: 'vip_rank',
  bonus_name: 'bonus_name',
  document_type: 'document_type',
  game: 'game',
  provider: 'provider',
};

/** Variable values detected in the message (first occurrence wins; crypto doubles as currency when no fiat). */
export function detectedVariables(entities: readonly Entity[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entities) {
    const key = ENTITY_VARIABLE[e.type];
    if (key && out[key] === undefined) out[key] = e.value;
  }
  if (out.crypto !== undefined && out.currency === undefined) out.currency = out.crypto;
  return out;
}

/** Variable names used by the given macro bodies, in order of first appearance, minus `exclude`. */
export function variablesUsed(bodies: readonly string[], exclude: readonly string[] = ['user']): string[] {
  const seen = new Set<string>(exclude);
  const out: string[] = [];
  for (const body of bodies) {
    for (const name of listVariables(body)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Agent-entered values sent to /api/personalize: trimmed, empty ones dropped, customer name -> {{user}}. */
export function requestVariables(customerName: string, overrides: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const v = value.trim();
    if (v) out[key] = v;
  }
  const name = customerName.trim();
  if (name) out.user = name;
  return out;
}

/** Personal values that must not be baked into a reusable macro. */
const PERSONAL_VARIABLES = ['email', 'tx_hash', 'bet_id', 'username', 'user'] as const;
const MIN_TEMPLATIZE_LENGTH = 3;
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Turn a customer-specific reply back into a reusable macro body: personal values (name, username, email,
 * tx hash, bet id) are replaced with their {{variable}}. Only whole-word occurrences of values with at least
 * 3 characters are replaced, so short or partial strings are never mangled.
 */
export function templatizeReply(text: string, values: Readonly<Record<string, string>>): string {
  const pairs = PERSONAL_VARIABLES.flatMap((key) => {
    const value = values[key]?.trim();
    return value && value.length >= MIN_TEMPLATIZE_LENGTH ? [{ key, value }] : [];
  }).sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const { key, value } of pairs) {
    const re = new RegExp(`(?<![\\w@.{])${value.replace(REGEX_SPECIALS, '\\$&')}(?![\\w@}])`, 'g');
    out = out.replace(re, `{{${key}}}`);
  }
  return out;
}
