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

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

export class LibraryService {
  private readonly active = new Map<Id, Macro>();

  constructor(
    private readonly macros: MacroRepo,
    private readonly categories: CategoryRepo,
    private readonly index: MacroIndex,
    private readonly cipher: Cipher,
  ) {}

  /** Embedding cache key for a macro's current content (equals macro_versions.content_hmac). */
  readonly keyOf = (m: Macro): string => this.cipher.hmac(JSON.stringify(canonicalContent(contentOf(m))));

  async init(): Promise<void> {
    this.active.clear();
    for (const m of this.macros.listAll()) this.active.set(m.id, m);
    await this.index.rebuild([...this.active.values()], this.keyOf);
  }

  /** Re-embed everything (after the embedder changed). */
  async reindex(): Promise<void> {
    await this.index.rebuild([...this.active.values()], this.keyOf);
  }

  count(): number {
    return this.active.size;
  }

  list(includeArchived = false): Macro[] {
    if (includeArchived) return this.macros.listAll({ includeArchived: true });
    return [...this.active.values()].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
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

  async importItems(req: ImportCommitRequest, source: ChangeSource = 'import', at?: Date): Promise<ImportCommitResult> {
    const result: ImportCommitResult = { created: 0, updated: 0, skipped: 0 };
    const byTitle = new Map<string, Id>();
    for (const m of this.active.values()) byTitle.set(normalizeTitle(m.title), m.id);

    for (const item of req.items) {
      const input = this.itemToInput(item);
      const dup = item.duplicateOf ?? byTitle.get(normalizeTitle(item.title)) ?? null;
      if (dup && this.active.has(dup)) {
        if (req.onDuplicate === 'skip') {
          result.skipped++;
          continue;
        }
        if (req.onDuplicate === 'new_version') {
          await this.update(dup, { ...input, changeNote: 'Imported update' }, source);
          result.updated++;
          continue;
        }
        input.title = `${input.title} (copy)`;
      }
      const created = await this.create(input, source, at);
      byTitle.set(normalizeTitle(created.title), created.id);
      result.created++;
    }
    return result;
  }

  private itemToInput(item: ImportItem): MacroInput {
    const categoryId = item.category?.trim() ? this.categories.ensureByName(item.category.trim()).id : null;
    return {
      title: item.title,
      body: item.body,
      categoryId,
      tags: item.tags,
      intents: item.intents,
      triggers: item.triggers,
      notes: item.notes,
      shortcut: item.shortcut,
      facts: item.facts,
    };
  }
}
