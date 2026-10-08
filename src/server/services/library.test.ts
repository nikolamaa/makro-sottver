import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FactInput, ImportCommitRequest, MacroInput } from '../../shared/types.js';
import { createCipher, type Cipher } from '../crypto/cipher.js';
import { openDatabase, type Db } from '../db/database.js';
import { CategoryRepo, EmbeddingRepo, MacroRepo } from '../db/repos.js';
import { parseImport, toExportJson } from '../importexport/importer.js';
import { createBuiltinEmbedder, type EmbedKind, type Embedder } from '../search/embedder.js';
import { MacroIndex } from '../search/macroIndex.js';
import { IMPORT_REBUILD_THRESHOLD, LibraryService } from './library.js';

/** Non-builtin embedder (so vectors go through the encrypted cache) that counts its passage calls. */
class CountingEmbedder implements Embedder {
  readonly provider = 'ollama' as const;
  readonly dim: number;
  calls = 0;
  passages = 0;
  private readonly inner = createBuiltinEmbedder();

  constructor(readonly model = 'fake-embed') {
    this.dim = this.inner.dim;
  }

  status() {
    return { provider: this.provider, model: this.model, state: 'ready' as const, detail: '' };
  }

  async init(): Promise<void> {}

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (kind === 'passage') {
      this.calls++;
      this.passages += texts.length;
    }
    return this.inner.embed(texts, kind);
  }
}

function macroInput(overrides: Partial<MacroInput> = {}): MacroInput {
  return {
    title: 'Account Closure - Close Your Account',
    body: 'Hi {{user}}, we can close your account once your balance is withdrawn.',
    categoryId: null,
    tags: ['account', 'closure'],
    intents: ['account_closure'],
    triggers: ['close my account', 'delete my account'],
    notes: 'Offer a break first.',
    shortcut: 'close',
    ...overrides,
  };
}

const verifiedFact = (key: string): FactInput => ({
  key,
  statement: `Statement ${key}`,
  value: key,
  sourceUrl: 'https://help.stake.com/en/',
  evidenceQuote: null,
  status: 'verified',
});

let db: Db;
let cipher: Cipher;
let macros: MacroRepo;
let categories: CategoryRepo;
let embeddings: EmbeddingRepo;
let embedder: CountingEmbedder;

function newLibrary(): LibraryService {
  const index = new MacroIndex({ embedder, cache: embeddings });
  return new LibraryService(macros, categories, index, cipher, (fn) => db.tx(fn));
}

function embeddingRows(): number {
  return (db.raw.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number }).n;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  cipher = createCipher(randomBytes(32));
  macros = new MacroRepo(db, cipher);
  categories = new CategoryRepo(db, cipher);
  embeddings = new EmbeddingRepo(db, cipher);
  embedder = new CountingEmbedder();
});

afterEach(() => db.close());

describe('LibraryService.importItems: save as new version', () => {
  it('keeps facts, verification and metadata when a text import replaces only the text', async () => {
    const library = newLibrary();
    const category = categories.create({ name: 'Account & Security', color: '#0891b2' });
    const original = await library.create({ ...macroInput({ categoryId: category.id }), facts: [verifiedFact('a'), verifiedFact('b')] });
    expect(original.verification).toBe('verified');

    const preview = parseImport('text', '### account closure - close your account\nHi {{first_name}}, here is the corrected text.', library.titles());
    expect(preview.items[0]?.duplicateOf).toBe(original.id);
    const res = await library.importItems({ items: preview.items, onDuplicate: 'new_version' });
    expect(res).toEqual({ created: 0, updated: 1, skipped: 0 });

    const updated = library.get(original.id);
    expect(updated.body).toBe('Hi {{user}}, here is the corrected text.');
    expect(updated.version).toBe(2);
    expect(updated.facts.map((f) => [f.key, f.status])).toEqual([
      ['a', 'verified'],
      ['b', 'verified'],
    ]);
    expect(updated.verification).toBe('verified');
    expect(updated).toMatchObject({
      categoryId: category.id,
      tags: original.tags,
      intents: original.intents,
      triggers: original.triggers,
      notes: original.notes,
      shortcut: original.shortcut,
    });
    expect(library.versions(original.id).map((v) => v.changeNote)).toEqual(['Imported update', '']);
  });

  it('replaces facts and metadata the import does supply', async () => {
    const library = newLibrary();
    const original = await library.create({ ...macroInput(), facts: [verifiedFact('a')] });
    const items = [
      {
        ...parseImport('text', '### Account Closure - Close Your Account\nCategory: Accounts\nTags: closure\nNew body', []).items[0]!,
        facts: [{ key: 'new', statement: 'New fact', value: '', sourceUrl: null, evidenceQuote: null }],
      },
    ];
    await library.importItems({ items, onDuplicate: 'new_version' });
    const updated = library.get(original.id);
    expect(updated.tags).toEqual(['closure']);
    expect(updated.categoryId).toBe(categories.list().find((c) => c.name === 'Accounts')?.id);
    expect(updated.facts.map((f) => f.key)).toEqual(['new']);
    expect(updated.intents).toEqual(original.intents);
  });
});

describe('LibraryService.importItems: duplicates inside one import', () => {
  const text = '### My New Macro\nFirst body\n---\n### my  new macro\nSecond body\n---\n### Other\nOther body';

  async function run(onDuplicate: ImportCommitRequest['onDuplicate']) {
    const library = newLibrary();
    const res = await library.importItems({ items: parseImport('text', text, library.titles()).items, onDuplicate });
    return { res, list: library.list() };
  }

  it('skips a repeated title with "skip"', async () => {
    const { res, list } = await run('skip');
    expect(res).toEqual({ created: 2, updated: 0, skipped: 1 });
    expect(list.map((m) => [m.title, m.body])).toEqual([
      ['My New Macro', 'First body'],
      ['Other', 'Other body'],
    ]);
  });

  it('saves a repeated title as a new version with "new_version"', async () => {
    const { res, list } = await run('new_version');
    expect(res).toEqual({ created: 2, updated: 1, skipped: 0 });
    expect(list.map((m) => [m.title, m.body, m.version])).toEqual([
      ['my new macro', 'Second body', 2],
      ['Other', 'Other body', 1],
    ]);
  });

  it('adds the copy suffix with "create_copy"', async () => {
    const { res, list } = await run('create_copy');
    expect(res).toEqual({ created: 3, updated: 0, skipped: 0 });
    expect(list.map((m) => m.title)).toEqual(['My New Macro', 'my new macro (copy)', 'Other']);
  });
});

describe('LibraryService.importItems: backup / JSON restore', () => {
  async function libraryA() {
    const source = newLibrary();
    const vip = source.createCategory({ name: 'VIP', color: '#dc2626' });
    const casino = source.createCategory({ name: 'Casino', color: '#7c3aed' });
    const old = await source.create(macroInput({ body: 'Old closure text.', categoryId: vip.id }));
    await source.archive(old.id);
    await source.create(macroInput({ body: 'Current closure text.', categoryId: vip.id }));
    const fav = await source.create(macroInput({ title: 'Slots RTP', body: 'RTP is listed in the game info.', categoryId: casino.id }));
    await source.setFavorite(fav.id, true);
    return toExportJson(source.list(true), source.listCategories());
  }

  it('restores archived macros as archived, favorites and category colors', async () => {
    const json = await libraryA();
    db.close();
    db = openDatabase(':memory:');
    macros = new MacroRepo(db, cipher);
    categories = new CategoryRepo(db, cipher);
    embeddings = new EmbeddingRepo(db, cipher);
    const target = newLibrary();

    const preview = parseImport('json', json, target.titles());
    const res = await target.importItems({ items: preview.items, onDuplicate: 'skip' });
    expect(res).toEqual({ created: 3, updated: 0, skipped: 0 });

    const active = target.list();
    expect(active.map((m) => m.body)).toEqual(['Current closure text.', 'RTP is listed in the game info.']);
    const archived = target.list(true).filter((m) => m.archivedAt);
    expect(archived.map((m) => m.body)).toEqual(['Old closure text.']);
    expect(active.filter((m) => m.isFavorite).map((m) => m.title)).toEqual(['Slots RTP']);
    expect(target.listCategories().map((c) => [c.name, c.color])).toEqual([
      ['Casino', '#7c3aed'],
      ['VIP', '#dc2626'],
    ]);

    // Restoring the same backup again changes nothing: active titles are duplicates, the archived macro is identical.
    const again = await target.importItems({ items: parseImport('json', json, target.titles()).items, onDuplicate: 'skip' });
    expect(again).toEqual({ created: 0, updated: 0, skipped: 3 });
    expect(target.list(true)).toHaveLength(3);
  });

  it('seeds the demo library with its category colors', async () => {
    const library = newLibrary();
    const preview = parseImport('json', readFileSync('seed/stake-demo-macros.json', 'utf8'), []);
    await library.importItems({ items: preview.items.map((i) => ({ ...i, duplicateOf: null })), onDuplicate: 'create_copy' }, 'seed');
    const colors = new Set(library.listCategories().map((c) => c.color));
    expect(colors.size).toBeGreaterThan(10);
  });
});

describe('LibraryService: embedding cache pruning', () => {
  it('drops vectors of hard-deleted macros and superseded versions, keeps archived ones', async () => {
    const library = newLibrary();
    await library.init();
    const a = await library.create(macroInput({ title: 'A' }));
    const b = await library.create(macroInput({ title: 'B' }));
    const c = await library.create(macroInput({ title: 'C' }));
    expect(embeddingRows()).toBe(6);
    await library.update(a.id, macroInput({ title: 'A', body: 'Edited body' }));
    expect(embeddingRows()).toBe(8);
    await library.archive(c.id);

    await library.hardDelete(b.id);
    // A (current version) + C (archived, kept so restoring it needs no re-embedding).
    expect(embeddingRows()).toBe(4);
    const keepKey = library.keyOf(library.get(a.id));
    const keys = (db.raw.prepare('SELECT content_hmac FROM embeddings').all() as { content_hmac: string }[]).map((r) => r.content_hmac);
    expect(keys).toEqual(expect.arrayContaining([`${keepKey}:head`, `${keepKey}:body`]));

    // Restart: init() prunes as well, and other models' vectors go when the embedder in use is named.
    await library.update(a.id, macroInput({ title: 'A', body: 'Edited again' }));
    const currentKey = library.keyOf(library.get(a.id));
    embeddings.set('ollama:old-model', `${currentKey}:head`, new Float32Array([1]));
    expect(embeddingRows()).toBe(7);
    await newLibrary().init();
    // A's current version (2) + C (2) + the other model's copy of A's head; A's previous version is gone.
    expect(embeddingRows()).toBe(5);
    expect(newLibrary().pruneEmbeddings('ollama:fake-embed')).toBe(1);
    expect(embeddingRows()).toBe(4);
  });
});

describe('LibraryService: corrupted rows', () => {
  it('starts, lists and exports the readable macros and reports the unreadable ones', async () => {
    const seed = newLibrary();
    const bad = await seed.create(macroInput({ title: 'Broken' }));
    await seed.create(macroInput({ title: 'Fine', facts: [verifiedFact('x')] }));
    const row = db.raw.prepare('SELECT rowid AS rid, payload FROM macro_versions WHERE macro_id = ?').get(bad.id) as { rid: number; payload: Uint8Array };
    const bytes = Buffer.from(row.payload);
    bytes[20] = (bytes[20] ?? 0) ^ 0xff;
    db.raw.prepare('UPDATE macro_versions SET payload = ? WHERE rowid = ?').run(bytes, row.rid);

    macros = new MacroRepo(db, cipher);
    const library = newLibrary();
    await expect(library.init()).resolves.toBeUndefined();
    expect(library.list().map((m) => m.title)).toEqual(['Fine']);
    expect(library.unreadableIds()).toEqual([bad.id]);
    const exported = JSON.parse(toExportJson(library.list(true), library.listCategories())) as { macros: { title: string }[] };
    expect(exported.macros.map((m) => m.title)).toEqual(['Fine']);
    expect(() => library.get(bad.id)).toThrow('Macro not found');
  });
});

describe('LibraryService.importItems: large imports', () => {
  it('embeds a large import in batches with one index rebuild instead of one call per macro', async () => {
    const library = newLibrary();
    await library.init();
    const count = 150;
    const json = JSON.stringify(Array.from({ length: count }, (_, i) => ({ title: `Macro ${i}`, body: `Body number ${i} about withdrawals.` })));
    const before = embedder.calls;
    const res = await library.importItems({ items: parseImport('json', json, []).items, onDuplicate: 'skip' });
    expect(res.created).toBe(count);
    expect(embedder.calls - before).toBeLessThanOrEqual(Math.ceil((count * 2) / 64));
    expect(library.count()).toBe(count);
    expect(embeddingRows()).toBe(count * 2);

    // The next large import reuses the cached vectors and embeds only the new macros.
    const more = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ title: `Extra ${i}`, body: `Extra body ${i}.` })));
    const passagesBefore = embedder.passages;
    await library.importItems({ items: parseImport('json', more, library.titles()).items, onDuplicate: 'skip' });
    expect(embedder.passages - passagesBefore).toBe(60);
    expect(library.count()).toBe(count + 30);
  });

  it('keeps per-macro index updates for small imports', async () => {
    const library = newLibrary();
    await library.init();
    const json = JSON.stringify(Array.from({ length: IMPORT_REBUILD_THRESHOLD }, (_, i) => ({ title: `M${i}`, body: `B${i}` })));
    await library.importItems({ items: parseImport('json', json, []).items, onDuplicate: 'skip' });
    expect(embedder.calls).toBe(IMPORT_REBUILD_THRESHOLD);
    expect(library.count()).toBe(IMPORT_REBUILD_THRESHOLD);
  });
});
