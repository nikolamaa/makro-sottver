/**
 * HTTP API contract between the web UI and the local server.
 *
 * All endpoints are JSON, served on http://127.0.0.1:<port>/api.
 * Every request from the UI MUST send the header `X-MacroPilot: <access token>` (see API_CLIENT_HEADER);
 * the server rejects API requests without a valid token (blocks other web pages and other OS users).
 * Errors are returned as { error: string } with a 4xx/5xx status.
 */
import type {
  AppSettings,
  Category,
  CategoryInput,
  DeepPartial,
  DraftRequest,
  DraftResponse,
  EmbedderStatus,
  FactInput,
  Fact,
  Id,
  ImportCommitRequest,
  ImportCommitResult,
  ImportFormat,
  ImportPreview,
  Macro,
  MacroInput,
  MacroVersion,
  PersonalizeRequest,
  PersonalizeResponse,
  RecommendRequest,
  RecommendResponse,
  RerankResponse,
  SecurityStatus,
  UsageEventInput,
  UsageSummary,
} from './types.js';

/**
 * Header that carries the per-install access token on every /api request. The token is
 * HMAC-SHA256(subkey of the master key, 'macropilot-access-v1') in base64url: stable for one installation and
 * derivable only by someone who can read the master key (the OS keychain or key file of this OS user).
 * The launcher opens the UI at `http://localhost:<port>/#/assist?k=<token>`; the UI keeps it in localStorage.
 */
export const API_CLIENT_HEADER = 'x-macropilot';
/** `error` of the 403 answer when the access token is missing or wrong (the UI then asks to use the launcher link). */
export const API_ACCESS_DENIED = 'Missing or invalid access token';

export interface ApiError {
  error: string;
}

export interface HealthResponse {
  ok: true;
  version: string;
  macroCount: number;
  embeddings: EmbedderStatus;
  ai: { provider: AppSettings['ai']['provider']; ready: boolean; detail: string };
}

/**
 * Route table. Path params are written as :name.
 * Method + path → request body / response body types.
 */
export interface ApiRoutes {
  'GET /api/health': { req: void; res: HealthResponse };

  // Macros
  'GET /api/macros': { req: void; res: Macro[] }; // ?archived=1 to include archived
  'GET /api/macros/:id': { req: void; res: Macro };
  'POST /api/macros': { req: MacroInput; res: Macro };
  'PUT /api/macros/:id': { req: MacroInput; res: Macro }; // creates a new version
  'DELETE /api/macros/:id': { req: void; res: { ok: true } }; // archive; ?hard=1 deletes permanently
  'POST /api/macros/:id/restore': { req: void; res: Macro };
  'POST /api/macros/:id/favorite': { req: { favorite: boolean }; res: Macro };
  'GET /api/macros/:id/versions': { req: void; res: MacroVersion[] };
  'POST /api/macros/:id/revert': { req: { version: number }; res: Macro };
  'PUT /api/macros/:id/facts': { req: { facts: FactInput[] }; res: Fact[] };

  // Categories
  'GET /api/categories': { req: void; res: Category[] };
  'POST /api/categories': { req: CategoryInput; res: Category };
  'PUT /api/categories/:id': { req: CategoryInput; res: Category };
  'DELETE /api/categories/:id': { req: void; res: { ok: true } }; // macros keep categoryId=null

  // Assist
  'POST /api/recommend': { req: RecommendRequest; res: RecommendResponse };
  /**
   * Optional AI double-check of the local recommendations (local result when the AI is off/not ready/failing).
   * `variables` are the agent-entered values (as for /api/personalize, e.g. the customer name as `user`): the
   * personal ones are pseudonymized in the message before it goes to a cloud AI.
   */
  'POST /api/rerank': { req: { message: string; variables?: Record<string, string> }; res: RerankResponse };
  'POST /api/personalize': { req: PersonalizeRequest; res: PersonalizeResponse };
  'POST /api/draft': { req: DraftRequest; res: DraftResponse };
  'POST /api/events': { req: UsageEventInput; res: { ok: true } }; // reply_copied also bumps macro useCount

  // Import / export
  'POST /api/import/preview': { req: { format: ImportFormat; content: string }; res: ImportPreview };
  'POST /api/import/commit': { req: ImportCommitRequest; res: ImportCommitResult };
  /** Open an encrypted .mpbackup (file content as text) with its recovery key; returns a preview to commit. */
  'POST /api/import/backup': { req: { backup: string; recoveryKey: string }; res: ImportPreview };
  // GET /api/export?format=json  -> application/json download (plaintext, UI must confirm first)
  // GET /api/export?format=backup -> application/octet-stream (.mpbackup, encrypted with the recovery key)

  // Settings & AI
  'GET /api/settings': { req: void; res: AppSettings };
  'PUT /api/settings': { req: DeepPartial<AppSettings>; res: AppSettings };
  'PUT /api/settings/anthropic-key': { req: { apiKey: string }; res: AppSettings };
  'DELETE /api/settings/anthropic-key': { req: void; res: AppSettings };
  'POST /api/ai/test': { req: void; res: { ok: boolean; detail: string } };
  'GET /api/usage': { req: void; res: UsageSummary };

  // Security
  'GET /api/security/status': { req: void; res: SecurityStatus };
  /** Returns the recovery key only while it has not been acknowledged yet (first run). */
  'GET /api/security/recovery-key': { req: void; res: { recoveryKey: string | null } };
  'POST /api/security/recovery-key/ack': { req: void; res: SecurityStatus };
  /** Generates a new recovery key (old one stops working), returns it once. */
  'POST /api/security/recovery-key/rotate': { req: void; res: { recoveryKey: string } };
}

export type ApiRouteKey = keyof ApiRoutes;
export type ApiReq<K extends ApiRouteKey> = ApiRoutes[K]['req'];
export type ApiRes<K extends ApiRouteKey> = ApiRoutes[K]['res'];

export type { Id };
