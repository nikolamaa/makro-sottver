/**
 * Pseudonymization of personal data before text is sent to a cloud LLM, and restoration afterwards.
 * Pure functions, no I/O. Tokens use U+27E6/U+27E7 brackets: ⟦EMAIL_1⟧, ⟦NAME_1⟧, ⟦TX_HASH_1⟧ ...
 */
import type { Entity, EntityType } from '../../shared/types.js';
import { boundedPattern } from './text.js';

export interface Pseudonymized {
  text: string;
  /** token -> original value, e.g. "⟦EMAIL_1⟧" -> "john@x.com" */
  mapping: Record<string, string>;
}

/** Entity types that are personal data, and their token labels. Amounts/currencies are never replaced. */
const ENTITY_TOKEN_TYPES: Partial<Record<EntityType, string>> = {
  email: 'EMAIL',
  name: 'NAME',
  username: 'USERNAME',
  phone: 'PHONE',
  tx_hash: 'TX_HASH',
  crypto_address: 'ADDRESS',
  bet_id: 'BET_ID',
};

/** Known variable names (e.g. agent-entered values) that hold personal data. */
const KNOWN_VALUE_TOKEN_TYPES: Record<string, string> = {
  user: 'NAME',
  name: 'NAME',
  email: 'EMAIL',
  username: 'USERNAME',
  phone: 'PHONE',
  tx_hash: 'TX_HASH',
  crypto_address: 'ADDRESS',
  bet_id: 'BET_ID',
};

const MIN_VALUE_LENGTH = 2;

/** ⟦NAME_1⟧, plus what LLMs tend to write instead: [[NAME_1]] and [NAME_1] (any case, inner spaces). */
const TOKEN_RE = /⟦\s*([A-Za-z][A-Za-z_]*_\d+)\s*⟧|\[\[\s*([A-Za-z][A-Za-z_]*_\d+)\s*\]\]|\[\s*([A-Za-z][A-Za-z_]*_\d+)\s*\]/g;

function tokenFor(type: string, n: number): string {
  return `⟦${type}_${n}⟧`;
}

/** Assigns stable tokens: the same value always gets the same token; numbering is per type, in order of first sight. */
class TokenRegistry {
  readonly mapping: Record<string, string> = {};
  /** value -> token (aliases included). */
  readonly byValue = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  /** Register the values of one item; all aliases share the token, the first one is restored. */
  add(type: string, values: string[]): void {
    const usable = [...new Set(values.map((v) => v.trim()).filter((v) => v.length >= MIN_VALUE_LENGTH))];
    const primary = usable[0];
    if (primary === undefined) return;
    let token = usable.map((v) => this.byValue.get(v)).find((t) => t !== undefined);
    if (token === undefined) {
      const n = (this.counters.get(type) ?? 0) + 1;
      this.counters.set(type, n);
      token = tokenFor(type, n);
      this.mapping[token] = primary;
    }
    for (const value of usable) if (!this.byValue.has(value)) this.byValue.set(value, token);
  }
}

/** Replace every occurrence of the given values with their tokens in one pass (longest value wins on overlap). */
function replaceValues(text: string, valueToToken: Map<string, string>): string {
  if (valueToToken.size === 0 || !text) return text;
  const values = [...valueToToken.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(values.map(boundedPattern).join('|'), 'gu');
  return text.replace(re, (match) => valueToToken.get(match) ?? match);
}

/**
 * Replace personal data with stable tokens before text goes to a cloud LLM: entities of type email, username,
 * name, phone, tx_hash, crypto_address, bet_id, plus personal values in `knownValues` (user/name -> NAME,
 * email -> EMAIL, username -> USERNAME, phone, tx_hash, bet_id, crypto_address; non-empty values >= 2 chars).
 * Same value -> same token. Tokens look like ⟦EMAIL_1⟧, ⟦NAME_1⟧, ⟦TX_HASH_1⟧. Amounts/currencies are kept.
 * Values are matched case-sensitively and exactly (with word boundaries), longest first, all occurrences.
 * The mapping also contains known values that do not occur in `text`, so callers can tokenize them elsewhere
 * (see applyPseudonyms).
 */
export function pseudonymize(text: string, entities: Entity[], knownValues: Record<string, string> = {}): Pseudonymized {
  const registry = new TokenRegistry();
  for (const entity of [...entities].sort((a, b) => a.start - b.start)) {
    const type = ENTITY_TOKEN_TYPES[entity.type];
    if (type) registry.add(type, text.includes(entity.raw) ? [entity.raw, entity.value] : [entity.value, entity.raw]);
  }
  for (const [key, value] of Object.entries(knownValues)) {
    const type = KNOWN_VALUE_TOKEN_TYPES[key.toLowerCase()];
    if (type && typeof value === 'string') registry.add(type, [value]);
  }
  return { text: replaceValues(text, registry.byValue), mapping: registry.mapping };
}

/** Tokenize another text (e.g. a variable value) with an existing mapping from pseudonymize(). */
export function applyPseudonyms(text: string, mapping: Record<string, string>): string {
  const valueToToken = new Map<string, string>();
  for (const [token, value] of Object.entries(mapping)) if (!valueToToken.has(value)) valueToToken.set(value, token);
  return replaceValues(text, valueToToken);
}

/**
 * Replace tokens back with original values. Tolerates ASCII variants an LLM may produce ([[NAME_1]], [NAME_1],
 * lowercase, inner spaces). Unknown tokens are left as-is.
 */
export function restorePseudonyms(text: string, mapping: Record<string, string>): string {
  return text.replace(TOKEN_RE, (match, a?: string, b?: string, c?: string) => {
    const name = (a ?? b ?? c ?? '').toUpperCase();
    return mapping[`⟦${name}⟧`] ?? match;
  });
}
