/**
 * HTTP layer (Fastify). Binds to 127.0.0.1 only. Because there is no login, every API request must prove it
 * comes from the MacroPilot UI itself:
 *   - Host header must be the local server (blocks DNS-rebinding attacks from malicious web pages),
 *   - the header `X-MacroPilot: <access token>` is required. The token is derived from the master key (see
 *     deriveAccessToken), so other OS users on the same machine cannot compute it, and a cross-site page can
 *     neither know it nor send a custom header without a CORS preflight, which this server never approves,
 *   - when an Origin header is present it must be the app's own origin.
 * "Is this an API request" is decided from the matched route and the percent-decoded path, never from the raw URL
 * string alone (the router decodes `/%61pi/...` to `/api/...`).
 */
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { API_ACCESS_DENIED, API_CLIENT_HEADER, type HealthResponse } from '../../shared/api.js';
import {
  INTENTS,
  type AppSettings,
  type DeepPartial,
  type ImportCommitRequest,
  type UsageSummary,
} from '../../shared/types.js';
import { AiError } from '../ai/provider.js';
import type { AiService } from '../ai/aiService.js';
import { createBackup, readBackup } from '../crypto/backup.js';
import type { EventRepo, LlmUsageRepo, SettingsRepo } from '../db/repos.js';
import { parseImport, toExportJson } from '../importexport/importer.js';
import { AssistService, BadRequestError } from '../services/assist.js';
import { LibraryService, NotFoundError } from '../services/library.js';
import type { SecurityService } from '../services/security.js';
import type { Embedder } from '../search/embedder.js';

export interface AppContext {
  version: string;
  port: number;
  isDev: boolean;
  webDir: string | null;
  masterKey: Buffer;
  /** Required in the X-MacroPilot header of every /api request (see deriveAccessToken). */
  accessToken: string;
  library: LibraryService;
  assist: AssistService;
  ai: AiService;
  settings: SettingsRepo;
  events: EventRepo;
  llmUsage: LlmUsageRepo;
  security: SecurityService;
  embedder: () => Embedder;
  /** Called after embedding settings changed (re-resolves the embedder in the background). */
  onEmbeddingSettingsChanged: () => void;
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const str = (max: number) => z.string().max(max);
const FactInputSchema = z.object({
  id: z.string().max(64).optional(),
  key: str(200).default(''),
  statement: str(2000),
  value: str(2000).default(''),
  sourceUrl: str(2000).nullable().default(null),
  evidenceQuote: str(4000).nullable().default(null),
  status: z.enum(['unchecked', 'verified', 'outdated', 'contradicted', 'unverifiable']).optional(),
});
const MacroInputSchema = z.object({
  title: str(200),
  body: str(20000),
  categoryId: z.string().max(64).nullable().default(null),
  tags: z.array(str(60)).max(40).default([]),
  intents: z.array(z.string().max(40)).max(10).default([]),
  triggers: z.array(str(500)).max(60).default([]),
  notes: str(5000).default(''),
  shortcut: str(60).default(''),
  facts: z.array(FactInputSchema).max(100).optional(),
  changeNote: str(500).optional(),
});
const CategoryInputSchema = z.object({ name: str(80), color: str(32).optional(), sort: z.number().int().optional() });
const MessageSchema = z.object({ message: z.string().max(20000) });
const VariablesSchema = z.record(z.string().max(60), z.string().max(500)).optional();
const PersonalizeSchema = z.object({
  message: z.string().max(20000),
  macroIds: z.array(z.string().max(64)).min(1).max(3),
  variables: VariablesSchema,
  mode: z.enum(['fast', 'ai']),
});
const DraftSchema = z.object({ message: z.string().max(20000), variables: VariablesSchema });
const RerankSchema = z.object({ message: z.string().max(20000), variables: VariablesSchema });
const EventSchema = z.object({
  type: z.enum(['recommendation_shown', 'recommendation_selected', 'reply_copied', 'no_match']),
  macroIds: z.array(z.string().max(64)).max(3).optional(),
  rank: z.number().int().min(0).max(10).optional(),
  confidence: z.number().min(0).max(100).optional(),
  intents: z.array(z.enum(INTENTS)).max(6).optional(),
  editRatio: z.number().min(0).max(1).optional(),
  mode: z.enum(['fast', 'ai']).optional(),
});
/** Large libraries (plain JSON exports, decrypted backups): the importer allows up to 30 MB / 20000 macros. */
const IMPORT_MAX_CONTENT_CHARS = 30 * 1024 * 1024;
const IMPORT_MAX_ITEMS = 20_000;
const IMPORT_BODY_LIMIT = 40 * 1024 * 1024;
const ImportPreviewSchema = z.object({ format: z.enum(['csv', 'json', 'text']), content: z.string().max(IMPORT_MAX_CONTENT_CHARS) });
const ImportItemSchema = z.object({
  title: str(200),
  body: str(20000),
  category: str(80).nullable().default(null),
  tags: z.array(str(60)).max(40).default([]),
  intents: z.array(z.enum(INTENTS)).max(10).default([]),
  triggers: z.array(str(500)).max(60).default([]),
  notes: str(5000).default(''),
  shortcut: str(60).default(''),
  facts: z.array(FactInputSchema).max(100).default([]),
  duplicateOf: z.string().max(64).nullable().default(null),
  // MacroPilot export/backup only (see ImportItem): without these, zod strips them and a restore
  // brings archived macros back as active and drops favorites and category colors.
  archived: z.boolean().optional(),
  isFavorite: z.boolean().optional(),
  categoryColor: z
    .string()
    .regex(/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
    .nullable()
    .optional(),
});
const ImportCommitSchema = z.object({
  items: z.array(ImportItemSchema).max(IMPORT_MAX_ITEMS),
  onDuplicate: z.enum(['skip', 'new_version', 'create_copy']),
});

// ---------------------------------------------------------------------------

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data ?? {});
}

function statusForAiError(err: AiError): number {
  switch (err.code) {
    case 'not_configured':
    case 'strict_local':
      return 400;
    case 'budget_exceeded':
      return 402;
    case 'refusal':
    case 'invalid_output':
      return 422;
    case 'rate_limit':
      return 429;
    case 'timeout':
      return 504;
    default:
      return 502;
  }
}

const VALIDATION_MESSAGE = /(is required|must be|invalid|too long|not allowed|between)/i;

function isApiPath(path: string): boolean {
  const p = path.toLowerCase();
  return p === '/api' || p.startsWith('/api/');
}

/**
 * True for every request that reaches (or could reach) the API: decided from the route the router matched and from
 * the percent-decoded path, so `/%61pi/settings` cannot skip the checks. Undecodable paths count as API (fail closed).
 */
export function isApiRequest(req: FastifyRequest): boolean {
  const route = req.routeOptions.url;
  if (route !== undefined && isApiPath(route)) return true;
  const rawPath = req.url.split('?', 1)[0] ?? '';
  if (isApiPath(rawPath)) return true;
  try {
    return isApiPath(decodeURIComponent(rawPath));
  } catch {
    return true;
  }
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 3 * 1024 * 1024, trustProxy: false });

  const allowedHosts = new Set([`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${ctx.port}`, `http://localhost:${ctx.port}`]);
  if (ctx.isDev) {
    for (const h of ['localhost:5173', '127.0.0.1:5173']) {
      allowedHosts.add(h);
      allowedOrigins.add(`http://${h}`);
    }
  }

  const expectedToken = Buffer.from(ctx.accessToken, 'utf8');
  const hasValidToken = (value: string | string[] | undefined): boolean => {
    if (typeof value !== 'string' || expectedToken.length === 0) return false;
    const given = Buffer.from(value, 'utf8');
    return given.length === expectedToken.length && timingSafeEqual(given, expectedToken);
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) return reply.code(403).send({ error: 'Forbidden host' });
    if (isApiRequest(req)) {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin.toLowerCase())) return reply.code(403).send({ error: 'Forbidden origin' });
      if (!hasValidToken(req.headers[API_CLIENT_HEADER])) return reply.code(403).send({ error: API_ACCESS_DENIED });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (isApiRequest(req)) {
      reply.header('Cache-Control', 'no-store');
    } else {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    }
    return payload;
  });

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: first ? `${first.path.join('.') || 'request'}: ${first.message}` : 'Invalid request' });
    }
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof BadRequestError) return reply.code(400).send({ error: err.message });
    if (err instanceof AiError) return reply.code(statusForAiError(err)).send({ error: err.message, code: err.code });
    const statusCode = (err as FastifyError).statusCode;
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: err.message });
    if (VALIDATION_MESSAGE.test(err.message) && !/decrypt/i.test(err.message)) return reply.code(400).send({ error: err.message });
    if (/not found/i.test(err.message)) return reply.code(404).send({ error: err.message });
    process.stderr.write(`[macropilot] internal error: ${err.name}: ${err.message}\n`);
    return reply.code(500).send({ error: 'Internal error' });
  });

  // Health -------------------------------------------------------------------
  app.get('/api/health', async (): Promise<HealthResponse> => ({
    ok: true,
    version: ctx.version,
    macroCount: ctx.library.count(),
    embeddings: ctx.embedder().status(),
    ai: ctx.ai.status(),
  }));

  // Macros -------------------------------------------------------------------
  app.get('/api/macros', async (req) => {
    const q = req.query as { archived?: string };
    return ctx.library.list(q.archived === '1' || q.archived === 'true');
  });
  app.get('/api/macros/:id', async (req) => ctx.library.get((req.params as { id: string }).id));
  app.post('/api/macros', async (req) => ctx.library.create(parse(MacroInputSchema, req.body) as never, 'create'));
  app.put('/api/macros/:id', async (req) =>
    ctx.library.update((req.params as { id: string }).id, parse(MacroInputSchema, req.body) as never, 'manual'),
  );
  app.delete('/api/macros/:id', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { hard?: string };
    if (q.hard === '1' || q.hard === 'true') await ctx.library.hardDelete(id);
    else await ctx.library.archive(id);
    return { ok: true as const };
  });
  app.post('/api/macros/:id/restore', async (req) => ctx.library.restore((req.params as { id: string }).id));
  app.post('/api/macros/:id/favorite', async (req) => {
    const body = parse(z.object({ favorite: z.boolean() }), req.body);
    return ctx.library.setFavorite((req.params as { id: string }).id, body.favorite);
  });
  app.get('/api/macros/:id/versions', async (req) => ctx.library.versions((req.params as { id: string }).id));
  app.post('/api/macros/:id/revert', async (req) => {
    const body = parse(z.object({ version: z.number().int().min(1) }), req.body);
    return ctx.library.revert((req.params as { id: string }).id, body.version);
  });
  app.put('/api/macros/:id/facts', async (req) => {
    const body = parse(z.object({ facts: z.array(FactInputSchema).max(100) }), req.body);
    return ctx.library.replaceFacts((req.params as { id: string }).id, body.facts);
  });

  // Categories ---------------------------------------------------------------
  app.get('/api/categories', async () => ctx.library.listCategories());
  app.post('/api/categories', async (req) => ctx.library.createCategory(parse(CategoryInputSchema, req.body)));
  app.put('/api/categories/:id', async (req) =>
    ctx.library.updateCategory((req.params as { id: string }).id, parse(CategoryInputSchema, req.body)),
  );
  app.delete('/api/categories/:id', async (req) => {
    ctx.library.deleteCategory((req.params as { id: string }).id);
    return { ok: true as const };
  });

  // Assist -------------------------------------------------------------------
  app.post('/api/recommend', async (req) => ctx.assist.recommend(parse(MessageSchema, req.body).message));
  app.post('/api/rerank', async (req, reply) => {
    const { message, variables } = parse(RerankSchema, req.body);
    // The browser aborts the double-check when the message changes: stop the AI call too (cost, busy local model).
    const dropped = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) dropped.abort();
    };
    reply.raw.once('close', onClose);
    try {
      return await ctx.assist.rerank(message, variables, dropped.signal);
    } finally {
      reply.raw.off('close', onClose);
    }
  });
  app.post('/api/personalize', async (req) => ctx.assist.personalize(parse(PersonalizeSchema, req.body)));
  app.post('/api/draft', async (req) => ctx.assist.draft(parse(DraftSchema, req.body)));
  app.post('/api/events', async (req) => {
    const event = parse(EventSchema, req.body);
    ctx.events.add(event);
    if (event.type === 'reply_copied' && event.macroIds?.length) await ctx.library.recordUse(event.macroIds);
    return { ok: true as const };
  });

  // Import / export ----------------------------------------------------------
  app.post('/api/import/preview', { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const body = parse(ImportPreviewSchema, req.body);
    return parseImport(body.format, body.content, ctx.library.titles());
  });
  app.post('/api/import/commit', { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const body = parse(ImportCommitSchema, req.body) as ImportCommitRequest;
    return ctx.library.importItems(body, 'import');
  });
  app.post('/api/import/backup', { bodyLimit: IMPORT_BODY_LIMIT }, async (req) => {
    const body = parse(z.object({ backup: z.string().min(1).max(IMPORT_BODY_LIMIT), recoveryKey: z.string().min(1).max(200) }), req.body);
    let library: unknown;
    try {
      library = readBackup<{ library?: unknown }>(body.backup, body.recoveryKey).payload.library;
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : 'Could not open the backup');
    }
    if (!library || typeof library !== 'object') throw new BadRequestError('The backup does not contain a macro library');
    return parseImport('json', JSON.stringify(library), ctx.library.titles());
  });
  app.get('/api/export', async (req, reply) => {
    const q = req.query as { format?: string };
    const stamp = new Date().toISOString().slice(0, 10);
    const json = toExportJson(ctx.library.list(true), ctx.library.listCategories());
    if (q.format === 'json') {
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="macropilot-macros-${stamp}.json"`)
        .send(json);
    }
    if (q.format === 'backup') {
      const file = createBackup({ library: JSON.parse(json) as unknown }, ctx.masterKey, ctx.security.wrappedKey());
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="macropilot-${stamp}.mpbackup"`)
        .send(file);
    }
    throw new BadRequestError('format must be json or backup');
  });

  // Settings & AI ------------------------------------------------------------
  app.get('/api/settings', async () => ctx.settings.get());
  app.put('/api/settings', async (req) => {
    const before = ctx.settings.get();
    const after = ctx.settings.update((req.body ?? {}) as DeepPartial<AppSettings>);
    if (JSON.stringify(before.embeddings) !== JSON.stringify(after.embeddings) || before.ai.ollamaUrl !== after.ai.ollamaUrl) {
      ctx.onEmbeddingSettingsChanged();
    }
    return after;
  });
  app.put('/api/settings/anthropic-key', async (req) => {
    const { apiKey } = parse(z.object({ apiKey: z.string().trim().min(10).max(300) }), req.body);
    ctx.settings.setSecret('anthropic_api_key', apiKey);
    return ctx.settings.get();
  });
  app.delete('/api/settings/anthropic-key', async () => {
    ctx.settings.setSecret('anthropic_api_key', null);
    return ctx.settings.get();
  });
  app.post('/api/ai/test', async () => ctx.ai.test());
  app.get('/api/usage', async (): Promise<UsageSummary> => {
    const month = new Date().toISOString().slice(0, 7);
    const totals = ctx.llmUsage.monthTotals(month);
    return { month, ...totals, budgetUsd: ctx.settings.get().ai.monthlyBudgetUsd };
  });

  // Security -----------------------------------------------------------------
  app.get('/api/security/status', async () => ctx.security.status());
  app.get('/api/security/recovery-key', async () => ({ recoveryKey: ctx.security.pendingRecoveryKey() }));
  app.post('/api/security/recovery-key/ack', async () => ctx.security.acknowledge());
  app.post('/api/security/recovery-key/rotate', async () => ({ recoveryKey: ctx.security.rotate() }));

  app.all('/api/*', async (_req, reply) => reply.code(404).send({ error: 'Unknown API endpoint' }));

  // Web UI -------------------------------------------------------------------
  if (ctx.webDir) {
    await app.register(fastifyStatic, { root: ctx.webDir, index: ['index.html'], wildcard: false, cacheControl: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !isApiRequest(req)) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html; charset=utf-8')
        .send('<!doctype html><title>MacroPilot</title><p>The web UI is not built. Run <code>npm run build</code> or use <code>npm run dev</code> (http://localhost:5173).</p>'),
    );
  }

  return app;
}
