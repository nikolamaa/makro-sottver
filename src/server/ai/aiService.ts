/**
 * High-level AI features with privacy + cost controls. Owns provider selection, budget enforcement,
 * pseudonymization, guardrails and graceful errors. Never throws for "AI not configured" from personalize():
 * callers check isReady() first; other failures throw AiError so the API can fall back to fast mode.
 */
import type {
  Analysis,
  AppSettings,
  DraftResponse,
  Fact,
  LlmUsage,
  Macro,
  PersonalizeResponse,
  Recommendation,
} from '../../shared/types.js';
import type { LlmProvider, LlmPurpose } from './provider.js';

export interface AiServiceDeps {
  getSettings(): AppSettings;
  getApiKey(): string | null;
  recordUsage(purpose: LlmPurpose, usage: LlmUsage): void;
  /** Spend so far this calendar month (USD). */
  monthSpendUsd(): number;
  /** Test seam: override provider construction. */
  providerFactory?: (settings: AppSettings, apiKey: string | null) => LlmProvider | null;
}

export class AiService {
  constructor(deps: AiServiceDeps) {
    throw new Error('TODO');
  }

  /** Provider per current settings, or null (provider 'none', missing key, strictLocal blocks cloud). */
  provider(): LlmProvider | null {
    throw new Error('TODO');
  }

  status(): { provider: AppSettings['ai']['provider']; ready: boolean; detail: string } {
    throw new Error('TODO');
  }

  isReady(): boolean {
    throw new Error('TODO');
  }

  test(): Promise<{ ok: boolean; detail: string }> {
    throw new Error('TODO');
  }

  /**
   * AI personalization: pseudonymize message + personal variables (when provider.isCloud && settings.ai.pseudonymize),
   * build personalizePrompt, call provider, restore pseudonyms, then run checkGrounding() against macro bodies,
   * facts, the original message and variables. Returns PersonalizeResponse with mode 'ai' and llm usage.
   * Throws AiError('budget_exceeded') when monthSpendUsd() >= monthlyBudgetUsd (> 0) for paid providers.
   */
  personalize(input: {
    message: string;
    analysis: Analysis;
    macros: Macro[];
    variables: Record<string, string>;
  }): Promise<PersonalizeResponse> {
    throw new Error('TODO');
  }

  /** Draft a reply from scratch when no macro fits; only verified facts may be used. */
  draft(input: { message: string; analysis: Analysis; variables: Record<string, string>; facts: Fact[] }): Promise<DraftResponse> {
    throw new Error('TODO');
  }

  /** Optional LLM re-rank of local candidates; returns re-ordered recommendations with AI reasons/confidence. */
  rerank(input: { message: string; analysis: Analysis; candidates: Recommendation[]; macros: Map<string, Macro> }): Promise<Recommendation[]> {
    throw new Error('TODO');
  }
}
