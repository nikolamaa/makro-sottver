/**
 * HTTP API contract between the web UI and the local server.
 *
 * All endpoints are JSON, served on http://127.0.0.1:<port>/api.
 * Every request from the UI MUST send the header `X-MacroPilot: 1` (see API_CLIENT_HEADER);
 * the server rejects API requests without it (blocks cross-site requests from other web pages).
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
  SecurityStatus,
  UsageEventInput,
  UsageSummary,
} from './types.js';

export const API_CLIENT_HEADER = 'x-macropilot';
export const API_CLIENT_HEADER_VALUE = '1';

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
  'POST /api/personalize': { req: PersonalizeRequest; res: PersonalizeResponse };
  'POST /api/draft': { req: DraftRequest; res: DraftResponse };
  'POST /api/events': { req: UsageEventInput; res: { ok: true } }; // reply_copied also bumps macro useCount

  // Import / export
  'POST /api/import/preview': { req: { format: ImportFormat; content: string }; res: ImportPreview };
  'POST /api/import/commit': { req: ImportCommitRequest; res: ImportCommitResult };
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
