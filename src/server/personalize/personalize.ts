/**
 * Deterministic ("fast") personalization + guardrails + pseudonymization. Pure functions, no I/O.
 *
 * This module is the public entry point; the building blocks live next to it:
 *   greeting.ts (ensureGreeting), tone.ts (applyTone), combine.ts (combineBodies),
 *   grounding.ts (checkGrounding), pseudonymize.ts (pseudonymize / restorePseudonyms).
 */
import { findPlaceholders, listVariables, placeholderLabel, renderTemplate } from '../../shared/template.js';
import type {
  Analysis,
  AppSettings,
  EntityType,
  GuardrailIssue,
  Macro,
  Placeholder,
  PersonalizeResponse,
} from '../../shared/types.js';
import { combineBodies } from './combine.js';
import { ensureGreeting, withUserFallback } from './greeting.js';
import { boundedPattern, tidyParagraphs, variableValue } from './text.js';
import { applyTone } from './tone.js';

export { ensureGreeting } from './greeting.js';
export { applyTone } from './tone.js';
export { combineBodies } from './combine.js';
export { checkGrounding, type GroundingSources } from './grounding.js';
export { applyPseudonyms, pseudonymize, restorePseudonyms, type Pseudonymized } from './pseudonymize.js';

export const RG_WARNING = 'Responsible gambling risk detected - follow the RG/wellbeing procedure before replying.';
export const NON_ENGLISH_WARNING = 'The message may not be in English - translate it in Intercom first.';
const PLACEHOLDER_DETAIL = 'Fill in this placeholder before sending.';

/** Entity type -> standard template variable. eta_time / date / link / bonus_amount are never filled from text. */
const ENTITY_VARIABLES: Partial<Record<EntityType, string>> = {
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

/** "john smith" -> "John Smith"; names that already contain a capital letter are kept as written. */
function displayName(name: string): string {
  return /\p{Lu}/u.test(name) ? name : name.replace(/(^|[\s'-])(\p{Ll})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

/**
 * Map analysis entities to standard template variables:
 *   name->user, username->username, email->email, amount->amount, currency->currency, crypto->crypto (and
 *   currency when no fiat currency was found), network->network, tx_hash->tx_hash, bet_id->bet_id,
 *   vip_rank->vip_rank, bonus_name->bonus_name, document_type->document_type, game->game, provider->provider.
 * NEVER fills eta_time / date / link / bonus_amount from customer text (those are policy values the agent
 * must confirm). First occurrence (by position in the message) wins.
 */
export function variablesFromAnalysis(analysis: Analysis): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const entity of [...analysis.entities].sort((a, b) => a.start - b.start)) {
    const name = ENTITY_VARIABLES[entity.type];
    const value = (entity.value || entity.raw).trim();
    if (!name || !value || Object.hasOwn(vars, name)) continue;
    vars[name] = name === 'user' ? displayName(value) : value;
  }
  if (!vars['currency'] && vars['crypto']) vars['currency'] = vars['crypto'];
  return vars;
}

export interface FastPersonalizeInput {
  message: string;
  macros: Macro[];
  analysis: Analysis;
  /** Agent overrides; win over detected values. */
  variables?: Record<string, string>;
  settings: AppSettings['personalization'];
}

/** Detected values overlaid with the agent's non-empty overrides (keys lowercased). */
function mergeVariables(detected: Record<string, string>, overrides: Record<string, string> | undefined): Record<string, string> {
  const merged: Record<string, string> = { ...detected };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (typeof value === 'string' && value.trim() !== '') merged[key.toLowerCase()] = value.trim();
  }
  return merged;
}

/** Questions whose intent none of the selected macros covers (questions without an intent are ignored). */
export function unansweredQuestions(analysis: Analysis, macros: Pick<Macro, 'intents'>[]): string[] {
  const covered = new Set(macros.flatMap((m) => m.intents));
  const out = analysis.questions.filter((q) => q.intent !== null && !covered.has(q.intent)).map((q) => q.text.trim());
  return [...new Set(out)].filter((q) => q !== '');
}

/** Visible warnings for a personalized reply: RG risk, non-English message, outdated/conflicting macros. */
export function personalizationWarnings(analysis: Analysis, macros: Pick<Macro, 'title' | 'verification'>[]): string[] {
  const warnings: string[] = [];
  if (analysis.rgRisk) warnings.push(RG_WARNING);
  if (analysis.isLikelyNonEnglish) warnings.push(NON_ENGLISH_WARNING);
  for (const macro of macros) {
    if (macro.verification === 'outdated' || macro.verification === 'conflict') {
      warnings.push(`Macro '${macro.title}' contains outdated or conflicting information - check the facts before sending.`);
    }
  }
  return warnings;
}

/** Ids of the macros' facts whose value appears in the text (case-insensitive, whitespace-normalized). */
function usedFactIds(macros: Pick<Macro, 'facts'>[], text: string): string[] {
  const haystack = text.replace(/\s+/g, ' ');
  const ids = new Set<string>();
  for (const fact of macros.flatMap((m) => m.facts)) {
    const value = fact.value.replace(/\s+/g, ' ').trim();
    if (value && new RegExp(boundedPattern(value), 'iu').test(haystack)) ids.add(fact.id);
  }
  return [...ids];
}

/** Every placeholder left in the text, linked to its variable when it came from a {{variable}}. */
function collectPlaceholders(text: string, templates: string[]): Placeholder[] {
  const byLabel = new Map<string, string>();
  for (const name of templates.flatMap((t) => listVariables(t))) byLabel.set(placeholderLabel(name), name);
  return findPlaceholders(text).map((label) => ({ label, variable: byLabel.get(label) ?? null }));
}

/**
 * Deterministic personalization:
 *   combine bodies (macros in the order given) -> render template (agent overrides > detected vars; a bare
 *   {{user}} falls back to settings.userFallback, inline fallbacks like {{user|valued customer}} win over it)
 *   -> ensureGreeting -> applyTone -> collect placeholders -> unansweredQuestions (questions whose intent is not
 *   in any selected macro's intents) -> warnings (rgRisk, non-English, outdated/conflicting macros)
 *   -> guardrail (one 'placeholder_left' issue per remaining placeholder).
 * mode = 'fast', llm = null, usedFactIds = ids of the selected macros' facts whose value appears in the text,
 * filledVariables = variables used by the reply that received a real (detected or agent) value.
 */
export function personalizeFast(input: FastPersonalizeInput): PersonalizeResponse {
  const { macros, analysis, settings } = input;
  const vars = mergeVariables(variablesFromAnalysis(analysis), input.variables);

  const combined = combineBodies(macros.map((m) => ({ title: m.title, body: m.body })));
  const rendered = renderTemplate(withUserFallback(combined, vars, settings.userFallback), vars).text;
  const greeted = ensureGreeting(rendered, settings.greeting, vars, settings.userFallback);
  const text = tidyParagraphs(applyTone(greeted, analysis, settings.toneAdjust).text);

  const templates = greeted === rendered ? [combined] : [combined, settings.greeting];
  const filledVariables: Record<string, string> = {};
  for (const name of templates.flatMap((t) => listVariables(t))) {
    const value = variableValue(vars, name);
    if (value !== undefined) filledVariables[name] = value;
  }
  const placeholders = collectPlaceholders(text, templates);
  const guardrail: GuardrailIssue[] = placeholders.map((p) => ({ kind: 'placeholder_left', text: p.label, detail: PLACEHOLDER_DETAIL }));

  return {
    text,
    mode: 'fast',
    filledVariables,
    placeholders,
    usedFactIds: usedFactIds(macros, text),
    unansweredQuestions: unansweredQuestions(analysis, macros),
    guardrail,
    warnings: personalizationWarnings(analysis, macros),
    llm: null,
  };
}
