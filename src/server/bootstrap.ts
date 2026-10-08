/**
 * Wires every component together. Kept separate from index.ts so tests can start a full app in-process.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ImportItem } from '../shared/types.js';
import { AiService } from './ai/aiService.js';
import { buildApp } from './api/app.js';
import type { AppConfig } from './config.js';
import { createCipher } from './crypto/cipher.js';
import { loadOrCreateMasterKey, type KeyStorage } from './crypto/keystore.js';
import { openDatabase, type Db } from './db/database.js';
import { CategoryRepo, EmbeddingRepo, EventRepo, LlmUsageRepo, MacroRepo, MetaRepo, SettingsRepo } from './db/repos.js';
import { parseImport } from './importexport/importer.js';
import { createBuiltinEmbedder, resolveEmbedder, type Embedder } from './search/embedder.js';
import { MacroIndex } from './search/macroIndex.js';
import { AssistService } from './services/assist.js';
import { LibraryService } from './services/library.js';
import { SecurityService, verifyKeyCheck } from './services/security.js';

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
  library: LibraryService;
  /** Resolves when the preferred embedder finished loading (or fell back). */
  embedderReady: Promise<void>;
  close(): Promise<void>;
}

export type Logger = (msg: string) => void;

export async function createRuntime(config: AppConfig, log: Logger = () => {}): Promise<Runtime> {
  const { key, storage, created } = await loadOrCreateMasterKey({
    keyDir: config.keyDir,
    envKey: config.envMasterKey,
    disableKeychain: config.disableKeychain,
  });
  if (created) log(`Created a new encryption key (stored in ${storage}).`);

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
  const loadPreferredEmbedder = async (): Promise<void> => {
    const generation = ++embedderGeneration;
    const s = settingsRepo.get();
    const preferred: Embedder = await resolveEmbedder(s.embeddings, {
      cacheDir: config.modelCacheDir,
      ollamaUrl: s.ai.ollamaUrl,
      log,
    });
    if (generation !== embedderGeneration) return;
    // Always swap, even to an identical builtin embedder: its status carries the fallback reason shown in the UI.
    // Re-indexing is cheap because vectors are cached per (model, content).
    await index.setEmbedder(preferred);
    log(`Search embeddings: ${preferred.provider} (${preferred.model}).`);
  };
  const embedderReady = loadPreferredEmbedder().catch((err: unknown) => log(`Embedder upgrade failed: ${String(err)}`));

  const app = await buildApp({
    version: config.version,
    port: config.port,
    isDev: config.isDev,
    webDir: config.webDir,
    masterKey: key,
    library,
    assist,
    ai,
    settings: settingsRepo,
    events: eventRepo,
    llmUsage: llmUsageRepo,
    security,
    embedder: () => index.embedder,
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
