/**
 * Deterministic ("fast") personalization + guardrails + pseudonymization. Pure functions, no I/O.
 */
import type {
  Analysis,
  AppSettings,
  Entity,
  Fact,
  GuardrailIssue,
  Macro,
  PersonalizeResponse,
} from '../../shared/types.js';

/**
 * Map analysis entities to standard template variables:
 *   name->user, username->username, email->email, amount->amount, currency->currency, crypto->crypto (and
 *   currency when no fiat currency was found), network->network, tx_hash->tx_hash, bet_id->bet_id,
 *   vip_rank->vip_rank, bonus_name->bonus_name, document_type->document_type, game->game, provider->provider.
 * NEVER fills eta_time / date / link / bonus_amount from customer text (those are policy values the agent
 * must confirm). First occurrence wins.
 */
export function variablesFromAnalysis(analysis: Analysis): Record<string, string> {
  throw new Error('TODO');
}

/**
 * Ensure the reply starts with a greeting. If the text already starts with a greeting (hi/hello/hey/dear/
 * good morning...), it is kept. Otherwise `greetingTemplate` (e.g. "Hi {{user}},") is rendered with `vars`
 * (user falls back to `userFallback`) and prepended on its own line.
 */
export function ensureGreeting(text: string, greetingTemplate: string, vars: Record<string, string>, userFallback: string): string {
  throw new Error('TODO');
}

/**
 * Tone adjustment based on sentiment/urgency. Inserts at most one short sentence right after the greeting line:
 *   angry/frustrated -> sincere apology + ownership (varied phrasings, chosen deterministically from the message)
 *   confused         -> reassurance ("No worries, here's how it works:")
 *   positive         -> thanks
 *   neutral          -> nothing
 * Skips insertion when the body already contains an apology/thanks sentence. Never promises outcomes.
 */
export function applyTone(text: string, analysis: Analysis, enabled: boolean): { text: string; added: string[] } {
  throw new Error('TODO');
}

/**
 * Combine several macro bodies into one reply: keep the first greeting only, drop repeated sign-offs/closing
 * lines ("Let me know if...", "Have a great day") except the last, separate parts with a blank line, and prefix
 * parts 2..n with a short bridge ("Regarding your question about <title lowercased>:").
 */
export function combineBodies(parts: { title: string; body: string }[]): string {
  throw new Error('TODO');
}

export interface FastPersonalizeInput {
  message: string;
  macros: Macro[];
  analysis: Analysis;
  /** Agent overrides; win over detected values. */
  variables?: Record<string, string>;
  settings: AppSettings['personalization'];
}

/**
 * Deterministic personalization:
 *   combine bodies -> render template (detected vars + overrides; {{user}} falls back to settings.userFallback)
 *   -> ensureGreeting -> applyTone -> collect placeholders -> unansweredQuestions (questions whose intent is not in
 *   any selected macro's intents) -> warnings (rgRisk, non-English, outdated facts) -> guardrail (left placeholders).
 * mode = 'fast', llm = null, usedFactIds = ids of the selected macros' facts whose value appears in the text.
 */
export function personalizeFast(input: FastPersonalizeInput): PersonalizeResponse {
  throw new Error('TODO');
}

export interface GroundingSources {
  macroBodies: string[];
  facts: Pick<Fact, 'statement' | 'value' | 'sourceUrl'>[];
  message: string;
  variables: Record<string, string>;
}

/**
 * Anti-hallucination check for AI-written replies. Flags:
 *  - unsupported_number: numbers/amounts/percentages/durations (e.g. "24 hours", "5%", "$100", "3-5 days") that do
 *    not appear in any source (macro bodies, fact statements/values, the customer message, variable values).
 *    Normalize before comparing (thousand separators, "24h" ~ "24 hours", words "one".."ten").
 *  - unsupported_url: URLs/domains not present in the sources.
 *  - promise: guarantee language not present in sources ("guarantee", "will definitely", "100%", "I promise",
 *    "will be credited today", "refund you").
 *  - placeholder_left: any [ENTER ...] placeholder left in the text.
 */
export function checkGrounding(reply: string, sources: GroundingSources): GuardrailIssue[] {
  throw new Error('TODO');
}

export interface Pseudonymized {
  text: string;
  /** token -> original value, e.g. "⟦EMAIL_1⟧" -> "john@x.com" */
  mapping: Record<string, string>;
}

/**
 * Replace personal data with stable tokens before text goes to a cloud LLM: entities of type email, username,
 * name, phone, tx_hash, crypto_address, bet_id, plus any value in `knownValues` (e.g. agent-entered user name).
 * Same value -> same token. Tokens look like ⟦EMAIL_1⟧, ⟦NAME_1⟧, ⟦TX_HASH_1⟧. Amounts/currencies are kept.
 */
export function pseudonymize(text: string, entities: Entity[], knownValues?: Record<string, string>): Pseudonymized {
  throw new Error('TODO');
}

/** Replace tokens back with original values (unknown tokens are left as-is). */
export function restorePseudonyms(text: string, mapping: Record<string, string>): string {
  throw new Error('TODO');
}
