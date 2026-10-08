/**
 * LibraryService: the single entry point for macro/category changes. Keeps the decrypted in-memory cache of
 * active macros and the search index in sync with the encrypted database.
 */
import type {
  Category,
  CategoryInput,
  ChangeSource,
  Fact,
  FactInput,
  Id,
  ImportCommitRequest,
  ImportCommitResult,
  ImportItem,
  Macro,
  MacroContent,
  MacroInput,
  MacroVersion,
} from '../../shared/types.js';
import type { Cipher } from '../crypto/cipher.js';
import { canonicalContent, type CategoryRepo, type MacroRepo } from '../db/repos.js';
import type { MacroIndex } from '../search/macroIndex.js';

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export function contentOf(m: MacroContent): MacroContent {
  return {
    title: m.title,
    body: m.body,
    categoryId: m.categoryId,
    tags: m.tags,
    intents: m.intents,
    triggers: m.triggers,
    notes: m.notes,
    shortcut: m.shortcut,
  };
}

const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Imports that write more macros than this refresh the search index with one rebuild (embeddings batched, cached
 * vectors reused) instead of one embedding call per macro.
 */
export const IMPORT_REBUILD_THRESHOLD = 20;

export class LibraryService {
  private readonly active = new Map<Id, Macro>();

  constructor(
    private readonly macros: MacroRepo,
    private readonly categories: CategoryRepo,
    private readonly index: MacroIndex,
    private readonly cipher: Cipher,
    /** Runs fn in one database transaction (all-or-nothing imports). */
    private readonly transaction: <T>(fn: () => T) => T = (fn) => fn(),
  ) {}

  /** Embedding cache key for a macro's current content (equals macro_versions.content_hmac). */
  readonly keyOf = (m: Macro): string => this.cipher.hmac(JSON.stringify(canonicalContent(contentOf(m))));

  /** Loads active macros and builds the index. Corrupted rows are skipped (see unreadableIds), never fatal. */
  async init(): Promise<void> {
    this.active.clear();
    for (const m of this.macros.listAll()) this.active.set(m.id, m);
    await this.index.rebuild([...this.active.values()], this.keyOf);
    this.pruneEmbeddings();
  }

  /** Re-embed everything (after the embedder changed). */
  async reindex(): Promise<void> {
    await this.index.rebuild([...this.active.values()], this.keyOf);
    this.pruneEmbeddings();
  }

  /**
   * Deletes cached embedding vectors (every model) of content no macro has any more: hard-deleted macros and
   * superseded versions. Archived macros keep theirs, so restoring one needs no re-embedding. With `onlyModel`
   * (`${provider}:${model}` of the embedder in use) the vectors of every other model are dropped as well.
   * Runs after init(), reindex() and hardDelete(). Returns the number of rows deleted; never throws (the cache is
   * only an optimization).
   */
  pruneEmbeddings(onlyModel?: string): number {
    try {
      const keys = new Set(this.macros.currentContentKeys());
      for (const m of this.active.values()) keys.add(this.keyOf(m));
      const keep = new Set<string>();
      for (const key of keys) {
        keep.add(`${key}:head`);
        keep.add(`${key}:body`);
      }
      return this.macros.pruneEmbeddings(keep, onlyModel);
    } catch {
      return 0;
    }
  }

  /** Ids of macros that could not be decrypted (corrupted rows); they are left out of the library and exports. */
  unreadableIds(): Id[] {
    return this.macros.unreadableIds();
  }

  count(): number {
    return this.active.size;
  }

  list(includeArchived = false): Macro[] {
    if (includeArchived) return this.macros.listAll({ includeArchived: true });
    return [...this.active.values()].sort((a, b) => titleCollator.compare(a.title, b.title));
  }

  /** Active macro from cache, falling back to the DB (archived macros). */
  get(id: Id): Macro {
    const m = this.active.get(id) ?? this.macros.get(id);
    if (!m) throw new NotFoundError('Macro');
    return m;
  }

  getActive(ids: Id[]): Macro[] {
    return ids.map((id) => this.get(id));
  }

  private async sync(m: Macro): Promise<Macro> {
    if (m.archivedAt) {
      this.active.delete(m.id);
      this.index.remove(m.id);
    } else {
      this.active.set(m.id, m);
      await this.index.upsert(m, this.keyOf(m));
    }
    return m;
  }

  async create(input: MacroInput, source: ChangeSource = 'create', at?: Date): Promise<Macro> {
    return this.sync(this.macros.create(input, source, at));
  }

  async update(id: Id, input: MacroInput, source: ChangeSource = 'manual'): Promise<Macro> {
    this.get(id);
    return this.sync(this.macros.update(id, input, source));
  }

  async archive(id: Id): Promise<void> {
    this.get(id);
    this.macros.archive(id);
    this.active.delete(id);
    this.index.remove(id);
  }

  async restore(id: Id): Promise<Macro> {
    this.get(id);
    return this.sync(this.macros.restore(id));
  }

  async hardDelete(id: Id): Promise<void> {
    this.get(id);
    this.macros.hardDelete(id);
    this.active.delete(id);
    this.index.remove(id);
    this.pruneEmbeddings();
  }

  async setFavorite(id: Id, favorite: boolean): Promise<Macro> {
    this.get(id);
    return this.sync(this.macros.setFavorite(id, favorite));
  }

  /** Called when a reply built from these macros was copied. */
  async recordUse(ids: Id[]): Promise<void> {
    for (const id of new Set(ids)) {
      if (!this.active.has(id)) continue;
      this.macros.recordUse(id);
      const fresh = this.macros.get(id);
      if (fresh) await this.sync(fresh);
    }
  }

  versions(id: Id): MacroVersion[] {
    this.get(id);
    return this.macros.listVersions(id);
  }

  async revert(id: Id, version: number): Promise<Macro> {
    this.get(id);
    return this.sync(this.macros.revert(id, version));
  }

  async replaceFacts(id: Id, facts: FactInput[]): Promise<Fact[]> {
    this.get(id);
    const result = this.macros.replaceFacts(id, facts);
    const fresh = this.macros.get(id);
    if (fresh) await this.sync(fresh);
    return result;
  }

  // Categories ---------------------------------------------------------------

  listCategories(): Category[] {
    return this.categories.list();
  }

  createCategory(input: CategoryInput): Category {
    return this.categories.create(input);
  }

  updateCategory(id: Id, input: CategoryInput): Category {
    return this.categories.update(id, input);
  }

  deleteCategory(id: Id): void {
    this.categories.delete(id);
  }

  // Import -------------------------------------------------------------------

  /** Existing (non-archived) macros used for duplicate detection during import preview. */
  titles(): Pick<Macro, 'id' | 'title'>[] {
    return [...this.active.values()].map((m) => ({ id: m.id, title: m.title }));
  }

  /**
   * Import macros all-or-nothing: either every item is written or none (the index is updated afterwards).
   * Duplicates (by duplicateOf or normalized title, including macros created earlier in the same import) follow
   * `onDuplicate`. 'new_version' replaces the text but keeps the existing facts, category, tags, intents, triggers,
   * notes and shortcut wherever the item leaves them empty. Archived items (backups) are restored as archived and
   * never matched as duplicates; one identical to an existing archived macro is skipped.
   */
  async importItems(req: ImportCommitRequest, source: ChangeSource = 'import', at?: Date): Promise<ImportCommitResult> {
    const result: ImportCommitResult = { created: 0, updated: 0, skipped: 0 };
    const byTitle = new Map<string, Id>();
    for (const m of this.active.values()) byTitle.set(normalizeTitle(m.title), m.id);
    /** Macros created by this import: later items with the same title are duplicates of them. */
    const createdHere = new Set<Id>();
    const isLive = (id: Id | null | undefined): id is Id => !!id && (this.active.has(id) || createdHere.has(id));
    const categoryIds = new Map<string, Id>();
    const archivedKeys = req.items.some((i) => i.archived)
      ? new Set(this.macros.listAll({ includeArchived: true }).filter((m) => m.archivedAt).map(this.keyOf))
      : new Set<string>();

    const written = this.transaction(() => {
      const out: Macro[] = [];
      for (const item of req.items) {
        const input = this.itemToInput(item, categoryIds);
        if (item.archived) {
          const key = this.cipher.hmac(JSON.stringify(canonicalContent(input)));
          if (archivedKeys.has(key)) {
            result.skipped++;
            continue;
          }
          archivedKeys.add(key);
          const { id } = this.macros.create(input, source, at);
          if (item.isFavorite) this.macros.setFavorite(id, true);
          this.macros.archive(id);
          const archived = this.macros.get(id);
          if (archived) out.push(archived);
          result.created++;
          continue;
        }
        const dup = [item.duplicateOf, byTitle.get(normalizeTitle(item.title))].find(isLive);
        if (dup) {
          if (req.onDuplicate === 'skip') {
            result.skipped++;
            continue;
          }
          if (req.onDuplicate === 'new_version') {
            // From the database: an earlier item of this import may have created or changed it.
            const existing = this.macros.get(dup) ?? this.active.get(dup);
            if (!existing) throw new NotFoundError('Macro');
            let updated = this.macros.update(dup, mergeImportedUpdate(existing, input), source);
            if (item.isFavorite) updated = this.macros.setFavorite(dup, true);
            out.push(updated);
            result.updated++;
            continue;
          }
          input.title = `${input.title} (copy)`;
        }
        let created = this.macros.create(input, source, at);
        if (item.isFavorite) created = this.macros.setFavorite(created.id, true);
        byTitle.set(normalizeTitle(created.title), created.id);
        createdHere.add(created.id);
        out.push(created);
        result.created++;
      }
      return out;
    });
    if (written.length > IMPORT_REBUILD_THRESHOLD) {
      for (const m of written) {
        if (m.archivedAt) this.active.delete(m.id);
        else this.active.set(m.id, m);
      }
      await this.index.rebuild([...this.active.values()], this.keyOf);
    } else {
      for (const m of written) await this.sync(m);
    }
    return result;
  }

  private itemToInput(item: ImportItem, categoryIds: Map<string, Id>): MacroInput {
    return {
      title: item.title,
      body: item.body,
      categoryId: this.importCategoryId(item, categoryIds),
      tags: item.tags,
      intents: item.intents,
      triggers: item.triggers,
      notes: item.notes,
      shortcut: item.shortcut,
      facts: item.facts,
    };
  }

  /** Category id for the item's category name, created (with the exported color) when missing; cached per import. */
  private importCategoryId(item: ImportItem, categoryIds: Map<string, Id>): Id | null {
    const name = item.category?.trim();
    if (!name) return null;
    const folded = normalizeTitle(name);
    let id = categoryIds.get(folded);
    if (id === undefined) {
      id = this.categories.ensureByName(name, item.categoryColor).id;
      categoryIds.set(folded, id);
    }
    return id;
  }
}

/**
 * Input for saving an imported item as a new version of `existing`: the item's text replaces the old one, but
 * facts and metadata the item leaves empty are kept (a text import has no facts, tags or triggers; replacing them
 * with nothing would silently delete facts, which are not versioned).
 */
function mergeImportedUpdate(existing: Macro, input: MacroInput): MacroInput {
  return {
    ...input,
    categoryId: input.categoryId ?? existing.categoryId,
    tags: input.tags.length ? input.tags : existing.tags,
    intents: input.intents.length ? input.intents : existing.intents,
    triggers: input.triggers.length ? input.triggers : existing.triggers,
    notes: input.notes.trim() ? input.notes : existing.notes,
    shortcut: input.shortcut.trim() ? input.shortcut : existing.shortcut,
    facts: input.facts?.length ? input.facts : undefined,
    changeNote: 'Imported update',
  };
}
