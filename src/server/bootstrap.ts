/**
 * Wires every component together. Kept separate from index.ts so tests can start a full app in-process.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ImportItem } from '../shared/types.js';
import { AiService, type AiServiceDeps } from './ai/aiService.js';
import { buildApp } from './api/app.js';
import type { AppConfig } from './config.js';
import { createCipher } from './crypto/cipher.js';
import { loadOrCreateMasterKey, type KeyStorage, type MasterKeyResult } from './crypto/keystore.js';
import { openDatabase, type Db } from './db/database.js';
import { CategoryRepo, EmbeddingRepo, EventRepo, LlmUsageRepo, MacroRepo, MetaRepo, SettingsRepo } from './db/repos.js';
import { parseImport } from './importexport/importer.js';
import { createBuiltinEmbedder, resolveEmbedder, type Embedder } from './search/embedder.js';
import { MacroIndex } from './search/macroIndex.js';
import { AssistService } from './services/assist.js';
import { LibraryService } from './services/library.js';
import { deriveAccessToken, SecurityService, verifyKeyCheck } from './services/security.js';

export class KeyMismatchError extends Error {
  constructor(readonly dbFile: string) {
    super(
      'The encryption key does not match the existing database. The key stored in the OS keychain / key file was ' +
        'probably lost or replaced. Restore it with your recovery key:  npm run recover',
    );
    this.name = 'KeyMismatchError';
  }
}

export interface Runtime {
  app: FastifyInstance;
  db: Db;
  keyStorage: KeyStorage;
  /** Value of the X-MacroPilot header every /api request must carry (see deriveAccessToken). */
  accessToken: string;
  library: LibraryService;
  /** Resolves when the preferred embedder finished loading (or fell back). */
  embedderReady: Promise<void>;
  close(): Promise<void>;
}

export type Logger = (msg: string) => void;

export interface RuntimeOptions {
  /** Master key already loaded with loadMasterKey() (index.ts needs it earlier for the single-instance check). */
  masterKey?: MasterKeyResult;
  /** Test seam (never set in production): replaces the real Claude/Ollama providers (see AiServiceDeps.providerFactory). */
  aiProviderFactory?: AiServiceDeps['providerFactory'];
}

/** Load the master key (OS keychain / key file / env), creating it on first run. */
export function loadMasterKey(config: AppConfig): Promise<MasterKeyResult> {
  return loadOrCreateMasterKey({ keyDir: config.keyDir, envKey: config.envMasterKey, disableKeychain: config.disableKeychain });
}

export async function createRuntime(config: AppConfig, log: Logger = () => {}, options: RuntimeOptions = {}): Promise<Runtime> {
  const { key, storage, created } = options.masterKey ?? (await loadMasterKey(config));
  if (created) log(`Created a new encryption key (stored in ${storage}).`);
  const accessToken = deriveAccessToken(key);

  const db = openDatabase(config.dbFile);
  const cipher = createCipher(key);
  const meta = new MetaRepo(db);
  if (!verifyKeyCheck(meta, cipher)) {
    db.close();
    throw new KeyMismatchError(config.dbFile);
  }

  const settingsRepo = new SettingsRepo(db, cipher);
  const macroRepo = new MacroRepo(db, cipher);
  const categoryRepo = new CategoryRepo(db, cipher);
  const eventRepo = new EventRepo(db, cipher);
  const llmUsageRepo = new LlmUsageRepo(db);
  const embeddingRepo = new EmbeddingRepo(db, cipher);

  const security = new SecurityService(meta, settingsRepo, key, storage, config.dataDir);
  if (security.ensureRecoveryKey()) log('Generated a recovery key - it will be shown in the app until you confirm you saved it.');

  // Search index starts with the builtin embedder so the app is usable immediately.
  const index = new MacroIndex({ embedder: createBuiltinEmbedder(), cache: embeddingRepo });
  const library = new LibraryService(macroRepo, categoryRepo, index, cipher, (fn) => db.tx(fn));

  const ai = new AiService({
    getSettings: () => settingsRepo.get(),
    getApiKey: () => settingsRepo.getSecret('anthropic_api_key') ?? process.env.ANTHROPIC_API_KEY ?? null,
    recordUsage: (purpose, usage) => llmUsageRepo.record(purpose, usage),
    monthSpendUsd: () => llmUsageRepo.monthTotals().costUsd,
    ...(options.aiProviderFactory ? { providerFactory: options.aiProviderFactory } : {}),
  });
  const assist = new AssistService(library, index, ai, () => settingsRepo.get());

  if (config.seedOnFirstRun && config.seedFile && meta.get('seeded') === null && macroRepo.listAll({ includeArchived: true }).length === 0) {
    const count = await seedLibrary(library, config.seedFile, log);
    log(`Loaded ${count} demo macros (Stake Help Center based).`);
  }
  meta.set('seeded', meta.get('seeded') ?? '1');

  await library.init();
  eventRepo.purgeOlderThan(settingsRepo.get().privacy.analyticsRetentionDays);

  // Upgrade to the preferred embedder in the background (e.g. local neural model), then re-index.
  let embedderGeneration = 0;
  /** The embedder last handed to the index (it may still be re-embedding with it). */
  let target: Embedder = index.embedder;
  /**
   * Builtin embedder whose status explains why the preferred provider is not in use (shown in the UI), while the
   * index keeps the equivalent builtin embedder it already has: builtin vectors are deterministic and not cached,
   * so swapping would re-embed the whole library for nothing. Only applies while `base` is the index's embedder.
   */
  let statusOverride: { base: Embedder; embedder: Embedder } | null = null;
  const sameBuiltin = (a: Embedder, b: Embedder) => a.provider === 'builtin' && b.provider === 'builtin' && a.model === b.model && a.dim === b.dim;
  const loadPreferredEmbedder = async (): Promise<void> => {
    const generation = ++embedderGeneration;
    const s = settingsRepo.get();
    const preferred: Embedder = await resolveEmbedder(s.embeddings, {
      cacheDir: config.modelCacheDir,
      ollamaUrl: s.ai.ollamaUrl,
      log,
    });
    if (generation !== embedderGeneration) return;
    if (sameBuiltin(target, preferred)) {
      statusOverride = { base: target, embedder: preferred };
    } else {
      statusOverride = null;
      target = preferred;
      try {
        await index.setEmbedder(preferred);
      } catch (err) {
        target = index.embedder;
        throw err;
      }
    }
    log(`Search embeddings: ${preferred.provider} (${preferred.model}).`);
  };
  const currentEmbedder = (): Embedder => {
    const current = index.embedder;
    return statusOverride && statusOverride.base === current ? statusOverride.embedder : current;
  };
  const embedderReady = loadPreferredEmbedder().catch((err: unknown) => log(`Embedder upgrade failed: ${String(err)}`));

  const app = await buildApp({
    version: config.version,
    port: config.port,
    isDev: config.isDev,
    webDir: config.webDir,
    masterKey: key,
    accessToken,
    library,
    assist,
    ai,
    settings: settingsRepo,
    events: eventRepo,
    llmUsage: llmUsageRepo,
    security,
    embedder: currentEmbedder,
    onEmbeddingSettingsChanged: () => {
      void loadPreferredEmbedder().catch((err: unknown) => log(`Embedder reload failed: ${String(err)}`));
    },
  });

  const purgeTimer = setInterval(() => eventRepo.purgeOlderThan(settingsRepo.get().privacy.analyticsRetentionDays), 6 * 3600_000);
  purgeTimer.unref();

  return {
    app,
    db,
    keyStorage: storage,
    accessToken,
    library,
    embedderReady,
    async close() {
      clearInterval(purgeTimer);
      await app.close();
      db.close();
    },
  };
}

/** Load demo macros (export-JSON format) through the normal import path. Import notes are logged, not fatal. */
export async function seedLibrary(library: LibraryService, seedFile: string, log: Logger = () => {}): Promise<number> {
  const preview = parseImport('json', readFileSync(seedFile, 'utf8'), []);
  if (preview.errors.length) log(`Demo library notes: ${preview.errors.slice(0, 3).join('; ')}`);
  const items: ImportItem[] = preview.items.map((i) => ({ ...i, duplicateOf: null }));
  const res = await library.importItems({ items, onDuplicate: 'create_copy' }, 'seed');
  return res.created;
}
