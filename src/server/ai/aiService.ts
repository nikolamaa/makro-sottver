/**
 * High-level AI features with privacy + cost controls. Owns provider selection, budget enforcement,
 * pseudonymization, guardrails and graceful errors. Never throws for "AI not configured" from personalize():
 * callers check isReady() first; other failures throw AiError so the API can fall back to fast mode.
 */
import type { z } from 'zod';
import type {
  Analysis,
  AppSettings,
  DraftResponse,
  Fact,
  LlmUsage,
  Macro,
  PersonalizeResponse,
  Placeholder,
  Recommendation,
} from '../../shared/types.js';
import { STANDARD_VARIABLES } from '../../shared/types.js';
import { findPlaceholders, listVariables, parseTemplate, placeholderLabel, renderTemplate } from '../../shared/template.js';
import { verificationWarnings } from '../../shared/verification.js';
import { checkGrounding, pseudonymize, restorePseudonyms } from '../personalize/personalize.js';
import {
  draftPrompt,
  OUTPUT_TOKEN_LIMITS,
  personalizePrompt,
  rankPrompt,
  type PromptPurpose,
  type PromptSpec,
  type RankCandidate,
} from './prompts.js';
import { AiError, createAnthropicProvider, createOllamaProvider, type LlmProvider, type LlmPurpose, type LlmResult } from './provider.js';

export interface AiServiceDeps {
  getSettings(): AppSettings;
  getApiKey(): string | null;
  recordUsage(purpose: LlmPurpose, usage: LlmUsage): void;
  /** Spend so far this calendar month (USD). */
  monthSpendUsd(): number;
  /** Test seam: override provider construction. */
  providerFactory?: (settings: AppSettings, apiKey: string | null) => LlmProvider | null;
}

const CLOUD_TIMEOUT_MS = 30_000;
/** Local models on a laptop CPU can need tens of seconds (plus model load on first use). */
const LOCAL_TIMEOUT_MS = 120_000;
const SUMMARY_CHARS = 300;
const TITLE_CHARS = 80;
const MAX_SUGGESTED_INTENTS = 3;
/** Personal values shorter than this are not string-masked (too likely to hit unrelated text). */
const MIN_MASK_LENGTH = 2;

const STRICT_LOCAL_MESSAGE = 'Strict local mode is on, so cloud AI is blocked. Use Ollama or turn off strict local mode in Settings.';
const RG_WARNING = 'Responsible gambling signals detected: follow the internal RG procedure before replying.';
const UNKNOWN_TOKEN_WARNING = 'The reply contains a ⟦...⟧ token the app could not restore. Replace it before sending.';

const PERSONAL_STANDARD_VARIABLES = new Set(['user', 'username', 'email', 'tx_hash', 'bet_id']);
const STANDARD_VARIABLE_SET = new Set<string>(STANDARD_VARIABLES);
/** Custom (non-standard) variable names that probably hold personal data. */
const PERSONAL_CUSTOM_VARIABLE_RE = /name|user|mail|phone|address|wallet|hash|iban|card|(?:^|_)id$/i;
const TOKEN_KIND_RE = /[^A-Z]+/g;
const EDGE_UNDERSCORES_RE = /^_+|_+$/g;
const LEFTOVER_TOKEN_RE = /⟦[^⟧\n]{1,40}⟧/;
const ALL_TOKENS_RE = /⟦[^⟧\n]{1,40}⟧/g;
const WHITESPACE_RE = /\s+/g;

/** Placeholder label -> standard variable, e.g. "[ENTER ETA TIME]" -> "eta_time". */
const STANDARD_PLACEHOLDERS: ReadonlyMap<string, string> = new Map(STANDARD_VARIABLES.map((v) => [placeholderLabel(v), v]));

type Availability =
  | { ok: true; provider: LlmProvider; settings: AppSettings }
  | { ok: false; error: AiError; settings: AppSettings };

/** What the model sees in place of customer data, and how to map its answer back. */
interface PrivacyView {
  message: string;
  variables: Record<string, string>;
  /** Applies the same pseudonyms to other customer-derived text (e.g. detected questions). */
  mask(text: string): string;
  restore(text: string): string;
}

export class AiService {
  private cached: { signature: string; provider: LlmProvider | null } | null = null;

  constructor(private readonly deps: AiServiceDeps) {}

  /** Provider per current settings, or null (provider 'none', missing key, strictLocal blocks cloud). */
  provider(): LlmProvider | null {
    const a = this.availability(false);
    return a.ok ? a.provider : null;
  }

  status(): { provider: AppSettings['ai']['provider']; ready: boolean; detail: string } {
    const a = this.availability(true);
    const provider = a.settings.ai.provider;
    return a.ok ? { provider, ready: true, detail: describeProvider(a.provider, a.settings) } : { provider, ready: false, detail: a.error.message };
  }

  isReady(): boolean {
    return this.availability(true).ok;
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    const a = this.availability(false);
    if (!a.ok) return { ok: false, detail: a.error.message };
    try {
      return await a.provider.test();
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'Connection test failed.' };
    }
  }

  /**
   * AI personalization: pseudonymize message + personal variables (when provider.isCloud && settings.ai.pseudonymize),
   * build personalizePrompt, call provider, restore pseudonyms, then run checkGrounding() against macro bodies,
   * facts, the original message and variables. Returns PersonalizeResponse with mode 'ai' and llm usage.
   * Throws AiError('budget_exceeded') when monthSpendUsd() >= monthlyBudgetUsd (> 0) for paid providers.
   */
  async personalize(input: {
    message: string;
    analysis: Analysis;
    macros: Macro[];
    variables: Record<string, string>;
  }): Promise<PersonalizeResponse> {
    const { provider, settings } = this.require();
    const view = privacyView(provider, settings, input.message, input.analysis, input.variables);
    const facts = usableFacts(input.macros);
    const p = settings.personalization;
    const spec = personalizePrompt({
      message: view.message,
      analysis: analysisForPrompt(input.analysis, view.mask),
      macros: input.macros.map((m) => ({ title: m.title, body: m.body })),
      facts: facts.map((f) => ({ id: f.id, statement: f.statement, value: f.value, status: f.status })),
      variables: view.variables,
      greeting: greetingLine(p.greeting, view.variables, p.userFallback),
      userFallback: p.userFallback,
    });
    const { data, usage } = await this.run('personalize', provider, settings, spec);

    const text = view.restore(data.reply).trim();
    const factIds = new Set(facts.map((f) => f.id));
    return {
      text,
      mode: 'ai',
      filledVariables: { ...input.variables },
      placeholders: collectPlaceholders(text, data.placeholders.map(view.restore), macroPlaceholders(input.macros)),
      usedFactIds: unique(data.used_fact_ids.filter((id) => factIds.has(id))),
      unansweredQuestions: cleanList(data.unanswered_questions.map(view.restore)),
      guardrail: checkGrounding(text, { macroBodies: input.macros.map((m) => m.body), facts, message: input.message, variables: input.variables }),
      warnings: unique([
        ...cleanList(data.notes_for_agent.map(view.restore)),
        ...input.macros.flatMap(staleFactWarnings),
        ...replyWarnings(text, input.analysis),
      ]),
      llm: usage,
    };
  }

  /** Draft a reply from scratch when no macro fits; only verified facts may be used. */
  async draft(input: { message: string; analysis: Analysis; variables: Record<string, string>; facts: Fact[] }): Promise<DraftResponse> {
    const { provider, settings } = this.require();
    const view = privacyView(provider, settings, input.message, input.analysis, input.variables);
    const facts = uniqueById(input.facts.filter((f) => f.status === 'verified'));
    const p = settings.personalization;
    const spec = draftPrompt({
      message: view.message,
      analysis: analysisForPrompt(input.analysis, view.mask),
      facts: facts.map((f) => ({ id: f.id, statement: f.statement, value: f.value, sourceUrl: f.sourceUrl })),
      greeting: greetingLine(p.greeting, view.variables, p.userFallback),
      userFallback: p.userFallback,
    });
    const { data, usage } = await this.run('draft', provider, settings, spec);

    const text = view.restore(data.reply).trim();
    const warnings = ['AI draft without a saved macro: check every statement before sending.'];
    if (!facts.length) warnings.push('No verified facts were available, so specific details are left as placeholders.');
    return {
      text,
      suggestedTitle: cleanTitle(data.suggested_title) || 'New macro',
      suggestedIntents: unique(data.suggested_intents).slice(0, MAX_SUGGESTED_INTENTS),
      placeholders: collectPlaceholders(text, data.placeholders.map(view.restore), STANDARD_PLACEHOLDERS),
      guardrail: checkGrounding(text, { macroBodies: [], facts, message: input.message, variables: input.variables }),
      warnings: unique([...warnings, ...replyWarnings(text, input.analysis)]),
      llm: usage,
    };
  }

  /**
   * Optional LLM re-rank of local candidates; returns re-ordered recommendations with AI reasons/confidence.
   * Breakdown, warnings and other local fields are kept. Never fails because of AI: on any AiError (not configured,
   * budget, network, invalid output...) the original candidates are returned unchanged.
   */
  async rerank(input: { message: string; analysis: Analysis; candidates: Recommendation[]; macros: Map<string, Macro> }): Promise<Recommendation[]> {
    if (!input.candidates.length) return [];
    try {
      const { provider, settings } = this.require();
      const view = privacyView(provider, settings, input.message, input.analysis, {});
      const candidates = input.candidates.map((c) => rankCandidate(c, input.macros.get(c.macroId)));
      const spec = rankPrompt(view.message, analysisForPrompt(input.analysis, view.mask), candidates);
      const { data } = await this.run('rerank', provider, settings, spec);
      return applyRanking(input.candidates, data.ranked, view.restore);
    } catch (err) {
      if (err instanceof AiError) return input.candidates;
      throw err;
    }
  }

  // -------------------------------------------------------------------------

  private require(): { provider: LlmProvider; settings: AppSettings } {
    const a = this.availability(true);
    if (!a.ok) throw a.error;
    return { provider: a.provider, settings: a.settings };
  }

  /** Resolves the provider and the first reason it cannot be used (strict local, not configured, budget). */
  private availability(checkBudget: boolean): Availability {
    const settings = this.deps.getSettings();
    const provider = this.build(settings);
    const cloud = provider ? provider.isCloud : settings.ai.provider === 'anthropic';
    if (settings.privacy.strictLocal && cloud) return { ok: false, settings, error: new AiError('strict_local', STRICT_LOCAL_MESSAGE) };
    if (!provider) return { ok: false, settings, error: new AiError('not_configured', notConfiguredMessage(settings)) };
    const budgetError = checkBudget && provider.isCloud ? this.budgetError(settings) : null;
    return budgetError ? { ok: false, settings, error: budgetError } : { ok: true, provider, settings };
  }

  private budgetError(settings: AppSettings): AiError | null {
    const budget = settings.ai.monthlyBudgetUsd;
    if (!(budget > 0)) return null;
    const spent = this.deps.monthSpendUsd();
    if (spent < budget) return null;
    return new AiError(
      'budget_exceeded',
      `Monthly AI budget of $${budget.toFixed(2)} reached ($${spent.toFixed(2)} spent). Raise it in Settings or use fast mode.`,
    );
  }

  /** Builds (and caches per configuration) the provider for the current settings. */
  private build(settings: AppSettings): LlmProvider | null {
    const apiKey = this.deps.getApiKey();
    if (this.deps.providerFactory) return this.deps.providerFactory(settings, apiKey);
    const ai = settings.ai;
    const signature = [ai.provider, ai.anthropicModel, ai.ollamaUrl, ai.ollamaModel, apiKey ?? ''].join('\n');
    if (this.cached?.signature !== signature) this.cached = { signature, provider: defaultProvider(settings, apiKey) };
    return this.cached.provider;
  }

  /** Calls the provider and records usage, including tokens billed by calls that failed after the API answered. */
  private async run<S extends z.ZodType>(
    purpose: PromptPurpose,
    provider: LlmProvider,
    settings: AppSettings,
    spec: PromptSpec<S>,
  ): Promise<LlmResult<z.infer<S>>> {
    try {
      const result = await provider.generateJson({
        purpose,
        system: spec.system,
        user: spec.user,
        schema: spec.schema,
        maxTokens: OUTPUT_TOKEN_LIMITS[purpose],
        effort: settings.ai.effort,
        timeoutMs: provider.isCloud ? CLOUD_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
      });
      this.deps.recordUsage(purpose, result.usage);
      return result;
    } catch (err) {
      if (err instanceof AiError && err.usage) this.deps.recordUsage(purpose, err.usage);
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

function defaultProvider(settings: AppSettings, apiKey: string | null): LlmProvider | null {
  const ai = settings.ai;
  if (ai.provider === 'anthropic') return apiKey ? createAnthropicProvider({ apiKey, model: ai.anthropicModel }) : null;
  if (ai.provider === 'ollama') return createOllamaProvider({ url: ai.ollamaUrl, model: ai.ollamaModel });
  return null;
}

function notConfiguredMessage(settings: AppSettings): string {
  if (settings.ai.provider === 'anthropic') return 'Add your Anthropic API key in Settings to use Claude.';
  return 'AI is off. Choose Claude or Ollama in Settings; fast mode works without AI.';
}

function describeProvider(provider: LlmProvider, settings: AppSettings): string {
  if (provider.id === 'ollama') return `Ollama (${provider.model}), runs locally`;
  return `Claude (${provider.model})${settings.ai.pseudonymize ? ', personal data pseudonymized' : ''}`;
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

function identity(text: string): string {
  return text;
}

function isPersonalVariable(name: string): boolean {
  return PERSONAL_STANDARD_VARIABLES.has(name) || (!STANDARD_VARIABLE_SET.has(name) && PERSONAL_CUSTOM_VARIABLE_RE.test(name));
}

/** Pseudonymizes only when text leaves the computer and the user asked for it. */
function privacyView(
  provider: LlmProvider,
  settings: AppSettings,
  message: string,
  analysis: Analysis,
  variables: Record<string, string>,
): PrivacyView {
  if (!provider.isCloud || !settings.ai.pseudonymize) return { message, variables, mask: identity, restore: identity };
  return pseudonymizedView(message, analysis, variables);
}

function pseudonymizedView(message: string, analysis: Analysis, variables: Record<string, string>): PrivacyView {
  const personal = Object.fromEntries(Object.entries(variables).filter(([name]) => isPersonalVariable(name)));
  const result = pseudonymize(message, analysis.entities, personal);
  const mapping = { ...result.mapping };
  const tokenByValue = new Map(Object.entries(mapping).map(([token, value]) => [value, token]));
  const maskedVariables: Record<string, string> = {};
  for (const [name, value] of Object.entries(variables)) {
    maskedVariables[name] = Object.hasOwn(personal, name) ? tokenFor(name, value, mapping, tokenByValue) : value;
  }
  // Longest first, so a full name is replaced before a part of it.
  const replacements = [...tokenByValue].filter(([value]) => value.length >= MIN_MASK_LENGTH).sort((a, b) => b[0].length - a[0].length);
  const mask = (text: string): string => replacements.reduce((acc, [value, token]) => acc.split(value).join(token), text);
  return {
    // Masking again catches personal variable values the entity-based pass did not cover.
    message: mask(result.text),
    variables: maskedVariables,
    mask,
    restore: (text) => restorePseudonyms(text, mapping),
  };
}

/** Existing token for a value, or a new ⟦KIND_n⟧ token registered in the mapping. */
function tokenFor(name: string, value: string, mapping: Record<string, string>, tokenByValue: Map<string, string>): string {
  const existing = tokenByValue.get(value);
  if (existing) return existing;
  const kind = name.toUpperCase().replace(TOKEN_KIND_RE, '_').replace(EDGE_UNDERSCORES_RE, '') || 'VALUE';
  let n = 1;
  while (Object.hasOwn(mapping, `⟦${kind}_${n}⟧`)) n++;
  const token = `⟦${kind}_${n}⟧`;
  mapping[token] = value;
  tokenByValue.set(value, token);
  return token;
}

/** The analysis fields prompts may show: entities/keywords (raw personal data) are dropped, customer text masked. */
function analysisForPrompt(analysis: Analysis, mask: (text: string) => string): Analysis {
  return {
    ...analysis,
    entities: [],
    keywords: [],
    urgencyReasons: [],
    questions: analysis.questions.map((q) => ({ ...q, text: mask(q.text) })),
    rgSignals: analysis.rgSignals.map(mask),
  };
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

function greetingLine(template: string, variables: Record<string, string>, userFallback: string): string {
  return renderTemplate(template, { user: userFallback, ...variables }).text.trim() || `Hi ${userFallback},`;
}

/** Facts the model may use: verified or unchecked (never outdated/contradicted/unverifiable), deduplicated. */
function usableFacts(macros: Macro[]): Fact[] {
  return uniqueById(macros.flatMap((m) => m.facts).filter((f) => f.status === 'verified' || f.status === 'unchecked'));
}

function staleFactWarnings(macro: Macro): string[] {
  const stale = macro.facts.filter((f) => f.status === 'outdated' || f.status === 'contradicted');
  return verificationWarnings(stale).map((w) => `${macro.title}: ${w}`);
}

function replyWarnings(text: string, analysis: Analysis): string[] {
  const warnings: string[] = [];
  if (analysis.rgRisk) warnings.push(RG_WARNING);
  if (LEFTOVER_TOKEN_RE.test(text)) warnings.push(UNKNOWN_TOKEN_WARNING);
  return warnings;
}

/** Placeholder labels of the macros' variables (plus the standard ones) -> variable name. */
function macroPlaceholders(macros: Macro[]): ReadonlyMap<string, string> {
  const map = new Map(STANDARD_PLACEHOLDERS);
  for (const m of macros) for (const v of listVariables(m.body)) map.set(placeholderLabel(v), v);
  return map;
}

/** Placeholders found in the text plus those the model reported, as long as they really occur in the text. */
function collectPlaceholders(text: string, reported: string[], variableByLabel: ReadonlyMap<string, string>): Placeholder[] {
  const labels = unique([...findPlaceholders(text), ...cleanList(reported).filter((label) => text.includes(label))]);
  return labels.map((label) => ({ label, variable: variableByLabel.get(label) ?? null }));
}

function cleanTitle(title: string): string {
  return title.replace(ALL_TOKENS_RE, '').replace(WHITESPACE_RE, ' ').trim().slice(0, TITLE_CHARS);
}

// ---------------------------------------------------------------------------
// Re-ranking helpers
// ---------------------------------------------------------------------------

/** Macro body as plain text: variables become their fallback text or disappear. */
function summarize(body: string): string {
  const text = parseTemplate(body)
    .map((t) => (t.kind === 'text' ? t.text : (t.fallback ?? '')))
    .join('');
  return text.replace(WHITESPACE_RE, ' ').trim().slice(0, SUMMARY_CHARS);
}

function rankCandidate(rec: Recommendation, macro: Macro | undefined): RankCandidate {
  return {
    id: rec.macroId,
    title: rec.title,
    intents: macro?.intents.length ? macro.intents : rec.coversIntents,
    summary: summarize(macro?.body ?? ''),
    verification: rec.verification,
  };
}

/**
 * AI ranking -> recommendations: unknown or repeated ids are dropped, AI-ranked candidates are sorted by AI
 * confidence, and candidates the model skipped follow with their local data (confidence capped below the AI list).
 */
function applyRanking(
  candidates: Recommendation[],
  ranked: { id: string; confidence: number; reason: string }[],
  restore: (text: string) => string,
): Recommendation[] {
  const remaining = new Map(candidates.map((c) => [c.macroId, c]));
  const out: Recommendation[] = [];
  for (const r of ranked) {
    const rec = remaining.get(r.id);
    if (!rec) continue;
    remaining.delete(r.id);
    out.push({ ...rec, confidence: clampConfidence(r.confidence), reason: restore(r.reason).trim() || rec.reason });
  }
  out.sort((a, b) => b.confidence - a.confidence);
  const floor = out.at(-1)?.confidence ?? 100;
  for (const rec of remaining.values()) out.push({ ...rec, confidence: Math.min(rec.confidence, floor) });
  return out;
}

function clampConfidence(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function cleanList(items: string[]): string[] {
  return unique(items.map((s) => s.trim()).filter(Boolean));
}
