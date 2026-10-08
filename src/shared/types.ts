/**
 * MacroPilot shared domain types.
 *
 * This file is the contract between the server (src/server) and the web UI (src/web).
 * Keep it dependency-free so both sides can import it.
 */

export type Id = string;
/** ISO-8601 timestamp string, e.g. 2026-10-08T14:22:00.000Z */
export type IsoDate = string;

// ---------------------------------------------------------------------------
// Intents (iGaming customer support taxonomy)
// ---------------------------------------------------------------------------

export const INTENTS = [
  'deposit_missing',
  'deposit_help',
  'withdrawal_pending',
  'withdrawal_help',
  'withdrawal_limits',
  'payment_methods',
  'bonus_inquiry',
  'wagering_requirement',
  'vip_program',
  'kyc_verification',
  'account_access',
  'account_security',
  'account_closure',
  'responsible_gambling',
  'sports_betting',
  'casino_games',
  'betting_limits',
  'technical_issue',
  'affiliate',
  'complaint',
  'general',
] as const;
export type Intent = (typeof INTENTS)[number];

export const INTENT_LABELS: Record<Intent, string> = {
  deposit_missing: 'Missing deposit',
  deposit_help: 'Deposit help',
  withdrawal_pending: 'Pending withdrawal',
  withdrawal_help: 'Withdrawal help',
  withdrawal_limits: 'Withdrawal limits',
  payment_methods: 'Payment methods',
  bonus_inquiry: 'Bonus inquiry',
  wagering_requirement: 'Wagering requirement',
  vip_program: 'VIP program',
  kyc_verification: 'Verification (KYC)',
  account_access: 'Account access',
  account_security: 'Account security',
  account_closure: 'Account closure',
  responsible_gambling: 'Responsible gambling',
  sports_betting: 'Sports betting',
  casino_games: 'Casino games',
  betting_limits: 'Betting limits',
  technical_issue: 'Technical issue',
  affiliate: 'Affiliates',
  complaint: 'Complaint',
  general: 'General',
};

export function isIntent(value: unknown): value is Intent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value);
}

export type Sentiment = 'angry' | 'frustrated' | 'confused' | 'neutral' | 'positive';
export type Urgency = 'low' | 'normal' | 'high' | 'critical';

// ---------------------------------------------------------------------------
// Macros, facts, versions, categories
// ---------------------------------------------------------------------------

/** Standard variable vocabulary. Macros may also use custom variable names. */
export const STANDARD_VARIABLES = [
  'user',
  'username',
  'email',
  'amount',
  'currency',
  'crypto',
  'network',
  'tx_hash',
  'bet_id',
  'bonus_name',
  'bonus_amount',
  'vip_rank',
  'eta_time',
  'product',
  'game',
  'provider',
  'date',
  'document_type',
  'link',
] as const;
export type StandardVariable = (typeof STANDARD_VARIABLES)[number];

export type ChangeSource = 'create' | 'manual' | 'import' | 'revert' | 'seed' | 'accuracy_check' | 'learning';

/**
 * Editable content of a macro. Stored encrypted (one encrypted payload per version).
 * Template syntax in `body`: {{variable}} or {{variable|fallback text}}.
 */
export interface MacroContent {
  title: string;
  body: string;
  categoryId: Id | null;
  tags: string[];
  intents: Intent[];
  /** Example customer phrasings this macro answers. Improves semantic matching. */
  triggers: string[];
  /** Internal notes for the agent; never inserted into replies. */
  notes: string;
  /** Optional short code for quick search, e.g. "wd-pending". */
  shortcut: string;
}

/** Roll-up of a macro's fact statuses. */
export type VerificationStatus = 'verified' | 'unverified' | 'outdated' | 'conflict';

export type FactStatus = 'unchecked' | 'verified' | 'outdated' | 'contradicted' | 'unverifiable';

export interface FactInput {
  /** Optional when creating; required when updating an existing fact in place. */
  id?: Id;
  /** Stable dotted key, e.g. "crypto.withdrawal.min_btc". */
  key: string;
  /** Human readable atomic statement. */
  statement: string;
  /** The concrete value as written in the source (number, duration, %, URL, rule). */
  value: string;
  sourceUrl: string | null;
  evidenceQuote: string | null;
  status?: FactStatus;
}

export interface Fact extends Required<Omit<FactInput, 'id' | 'status'>> {
  id: Id;
  macroId: Id;
  status: FactStatus;
  lastCheckedAt: IsoDate | null;
}

export interface Macro extends MacroContent {
  id: Id;
  version: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  archivedAt: IsoDate | null;
  isFavorite: boolean;
  useCount: number;
  lastUsedAt: IsoDate | null;
  verification: VerificationStatus;
  facts: Fact[];
}

export interface MacroVersion {
  macroId: Id;
  version: number;
  createdAt: IsoDate;
  changeSource: ChangeSource;
  changeNote: string;
  content: MacroContent;
}

export interface MacroInput extends MacroContent {
  facts?: FactInput[];
  changeNote?: string;
}

export interface Category {
  id: Id;
  name: string;
  /** CSS color, e.g. "#4f7cff" */
  color: string;
  sort: number;
}

export interface CategoryInput {
  name: string;
  color?: string;
  sort?: number;
}

// ---------------------------------------------------------------------------
// Message analysis
// ---------------------------------------------------------------------------

export type EntityType =
  | 'email'
  | 'username'
  | 'name'
  | 'amount'
  | 'currency'
  | 'crypto'
  | 'network'
  | 'tx_hash'
  | 'crypto_address'
  | 'bet_id'
  | 'vip_rank'
  | 'bonus_name'
  | 'duration'
  | 'date'
  | 'url'
  | 'phone'
  | 'document_type'
  | 'game'
  | 'provider';

export interface Entity {
  type: EntityType;
  /** Normalized value, e.g. amount "250", currency "USDT", crypto "BTC". */
  value: string;
  /** Raw matched text. */
  raw: string;
  /** Character offsets in the original message. */
  start: number;
  end: number;
}

export interface QuestionSpan {
  text: string;
  intent: Intent | null;
}

export interface IntentScore {
  intent: Intent;
  /** 0..1 */
  score: number;
}

export interface Analysis {
  /** Sorted by score desc; at most 3; empty only for empty input. */
  intents: IntentScore[];
  sentiment: Sentiment;
  /** -1 (very negative) .. 1 (very positive) */
  sentimentScore: number;
  urgency: Urgency;
  urgencyReasons: string[];
  entities: Entity[];
  /** Distinct questions/requests found in the message (multi-question support). */
  questions: QuestionSpan[];
  /** Salient lowercase keywords used for matching/explanations. */
  keywords: string[];
  /** Responsible-gambling / player-wellbeing risk signals detected. */
  rgRisk: boolean;
  rgSignals: string[];
  isLikelyNonEnglish: boolean;
  wordCount: number;
  source: 'local' | 'llm';
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  /** All components normalized to 0..1 */
  semantic: number;
  lexical: number;
  intent: number;
  usage: number;
}

export interface Recommendation {
  macroId: Id;
  title: string;
  categoryId: Id | null;
  /** 0..100 */
  confidence: number;
  /** One sentence explaining why this macro was picked. */
  reason: string;
  matchedTerms: string[];
  coversIntents: Intent[];
  verification: VerificationStatus;
  /** Visible warnings, e.g. "1 fact outdated since 2026-10-02". */
  warnings: string[];
  breakdown: ScoreBreakdown;
}

export interface RecommendRequest {
  message: string;
}

export interface RecommendResponse {
  analysis: Analysis;
  /** 0..3 recommendations, best first. */
  recommendations: Recommendation[];
  /** True when the best confidence is below the configured threshold. */
  noGoodMatch: boolean;
  /** Present when the message contains questions the top macro does not cover. */
  uncoveredIntents: Intent[];
  /** Template variable values detected in the message (same mapping the server uses when personalizing). */
  detectedVariables: Record<string, string>;
  embeddings: EmbedderStatus;
  timingMs: { analysis: number; search: number; total: number };
}

export type RerankRequest = RecommendRequest;

/**
 * AI double-check of the local recommendations for one message (POST /api/rerank). The local candidates are
 * re-scored by the AI; when the AI is not ready, turned off or fails, the local result is returned unchanged.
 */
export interface RerankResponse {
  /** At most settings.recommendation.maxResults recommendations, best first (AI confidence/reason when aiUsed). */
  recommendations: Recommendation[];
  /** True when the best confidence (the AI's when aiUsed) is below the configured threshold. */
  noGoodMatch: boolean;
  /** True when the AI ranking was applied; false = local result (AI off, not ready, disabled or failed). */
  aiUsed: boolean;
  /** Tokens and cost of the AI call; null when the AI was not used. */
  llm: LlmUsage | null;
}

// ---------------------------------------------------------------------------
// Personalization / drafting
// ---------------------------------------------------------------------------

export type PersonalizeMode = 'fast' | 'ai';

export interface PersonalizeRequest {
  message: string;
  /** 1..3 macros; more than one = combined reply. */
  macroIds: Id[];
  /** Agent-entered overrides, e.g. { user: "Marko", eta_time: "24 hours" }. */
  variables?: Record<string, string>;
  mode: PersonalizeMode;
}

export interface Placeholder {
  /** Text inserted into the reply, e.g. "[ENTER ETA TIME]". */
  label: string;
  /** Variable the placeholder stands for, if any. */
  variable: string | null;
}

export type GuardrailKind =
  | 'unsupported_number'
  | 'unsupported_url'
  | 'unsupported_claim'
  | 'promise'
  | 'placeholder_left';

export interface GuardrailIssue {
  kind: GuardrailKind;
  /** The offending text fragment in the reply. */
  text: string;
  detail: string;
}

export interface LlmUsage {
  provider: AiProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface PersonalizeResponse {
  text: string;
  mode: PersonalizeMode;
  filledVariables: Record<string, string>;
  placeholders: Placeholder[];
  usedFactIds: Id[];
  unansweredQuestions: string[];
  guardrail: GuardrailIssue[];
  warnings: string[];
  llm: LlmUsage | null;
}

export interface DraftRequest {
  message: string;
  variables?: Record<string, string>;
}

export interface DraftResponse {
  text: string;
  suggestedTitle: string;
  suggestedIntents: Intent[];
  placeholders: Placeholder[];
  guardrail: GuardrailIssue[];
  warnings: string[];
  llm: LlmUsage | null;
}

// ---------------------------------------------------------------------------
// AI providers, embeddings, settings
// ---------------------------------------------------------------------------

export type AiProviderId = 'none' | 'anthropic' | 'ollama';
export type EmbeddingProviderId = 'auto' | 'builtin' | 'transformers' | 'ollama';
export type AiEffort = 'low' | 'medium' | 'high';

export interface EmbedderStatus {
  /** Provider actually in use. */
  provider: 'builtin' | 'transformers' | 'ollama';
  model: string;
  state: 'ready' | 'loading' | 'error';
  detail: string;
}

export interface AppSettings {
  ai: {
    provider: AiProviderId;
    anthropicModel: string;
    /** True when an API key is stored (the key itself is never sent to the UI). */
    anthropicKeySet: boolean;
    ollamaUrl: string;
    ollamaModel: string;
    effort: AiEffort;
    /** Run AI personalization automatically when a recommendation is selected. */
    autoPolish: boolean;
    /**
     * AI double-check of recommendations: after the instant local match, the AI re-scores the top local
     * candidates (POST /api/rerank). Only used when a provider is ready; never delays the local result.
     */
    rerank: boolean;
    /** Hard monthly spend cap in USD for paid providers; 0 = no cap. */
    monthlyBudgetUsd: number;
    /** Replace personal data with tokens before sending text to a cloud LLM. */
    pseudonymize: boolean;
  };
  embeddings: {
    provider: EmbeddingProviderId;
    ollamaModel: string;
  };
  personalization: {
    /** Greeting line template used when a macro has no greeting, e.g. "Hi {{user}},". */
    greeting: string;
    /** Value for {{user}} when the name is unknown, e.g. "there". */
    userFallback: string;
    /** Add empathy/clarity sentences based on detected sentiment. */
    toneAdjust: boolean;
  };
  recommendation: {
    /** Below this confidence (0..100) the UI shows "no good match". */
    minConfidence: number;
    maxResults: number;
  };
  accuracy: {
    enabled: boolean;
    /** Interval between automatic accuracy checks, default 48 (every 2 days). */
    intervalHours: number;
    autoApproveMinor: boolean;
  };
  privacy: {
    /** Analytics events older than this are deleted. */
    analyticsRetentionDays: number;
    /** When true, never call cloud APIs (only local providers). */
    strictLocal: boolean;
  };
  ui: {
    theme: 'system' | 'light' | 'dark';
    /** Read the clipboard automatically when the Assist window gains focus. */
    autoReadClipboard: boolean;
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    provider: 'none',
    anthropicModel: 'claude-haiku-5-5',
    anthropicKeySet: false,
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen2.5:3b',
    effort: 'low',
    autoPolish: false,
    rerank: true,
    monthlyBudgetUsd: 5,
    pseudonymize: true,
  },
  embeddings: {
    provider: 'auto',
    ollamaModel: 'nomic-embed-text',
  },
  personalization: {
    greeting: 'Hi {{user}},',
    userFallback: 'there',
    toneAdjust: true,
  },
  recommendation: {
    minConfidence: 45,
    maxResults: 3,
  },
  accuracy: {
    enabled: true,
    intervalHours: 48,
    autoApproveMinor: false,
  },
  privacy: {
    analyticsRetentionDays: 90,
    strictLocal: false,
  },
  ui: {
    theme: 'system',
    autoReadClipboard: false,
  },
};

export interface UsageSummary {
  /** Calendar month, e.g. "2026-10" */
  month: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  budgetUsd: number;
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export type ImportFormat = 'csv' | 'json' | 'text';

export interface ImportItem {
  title: string;
  body: string;
  /** Category name (resolved/created on commit). */
  category: string | null;
  tags: string[];
  intents: Intent[];
  triggers: string[];
  notes: string;
  shortcut: string;
  facts: FactInput[];
  /** True when a macro with the same normalized title already exists. */
  duplicateOf: Id | null;
  /** MacroPilot export/backup only: the macro was archived. It is restored as archived and never matched as a duplicate. */
  archived?: boolean;
  /** MacroPilot export/backup only: the macro was a favorite. */
  isFavorite?: boolean;
  /** Color of `category` from the file's categories list (hex), used when the category has to be created. */
  categoryColor?: string | null;
}

export interface ImportPreview {
  items: ImportItem[];
  errors: string[];
}

export interface ImportCommitRequest {
  items: ImportItem[];
  /** What to do with items whose duplicateOf is set. */
  onDuplicate: 'skip' | 'new_version' | 'create_copy';
}

export interface ImportCommitResult {
  created: number;
  updated: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export interface SecurityStatus {
  /** Where the master key lives. */
  keyStorage: 'keychain' | 'file' | 'env';
  /** False until the user confirms they saved the recovery key. */
  recoveryKeyAcknowledged: boolean;
  dataDir: string;
  encryptedAtRest: true;
}

// ---------------------------------------------------------------------------
// Analytics events (Phase 1 records them; Phase 4 analyzes them)
// ---------------------------------------------------------------------------

export type UsageEventType = 'recommendation_shown' | 'recommendation_selected' | 'reply_copied' | 'no_match';

export interface UsageEventInput {
  type: UsageEventType;
  macroIds?: Id[];
  /** Rank (0-based) of the selected recommendation. */
  rank?: number;
  confidence?: number;
  intents?: Intent[];
  /** Character-level edit ratio between generated and copied text (0 = unchanged, 1 = rewritten). */
  editRatio?: number;
  mode?: PersonalizeMode;
}
