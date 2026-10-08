/**
 * Repositories: the only code that touches SQL. All user content is encrypted with the Cipher using the
 * AAD conventions documented in schema.ts. All methods are synchronous (node:sqlite is synchronous and fast).
 * IDs are generated with crypto.randomUUID(). Timestamps are ISO strings (new Date().toISOString()).
 */
import { randomUUID } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import {
  DEFAULT_SETTINGS,
  isIntent,
  type AppSettings,
  type Category,
  type CategoryInput,
  type ChangeSource,
  type DeepPartial,
  type Fact,
  type FactInput,
  type FactStatus,
  type Id,
  type LlmUsage,
  type Macro,
  type MacroContent,
  type MacroInput,
  type MacroVersion,
  type PersonalizeMode,
  type UsageEventInput,
  type UsageEventType,
  type VerificationStatus,
} from '../../shared/types.js';
import { rollupVerification } from '../../shared/verification.js';
import { DecryptionError, type Cipher } from '../crypto/cipher.js';
import type { Db } from './database.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Returns a function that prepares each SQL string once and reuses the statement afterwards. */
function statementCache(db: Db): (sql: string) => StatementSync {
  const cache = new Map<string, StatementSync>();
  return (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.raw.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };
}

const iso = (at?: Date): string => (at ?? new Date()).toISOString();

const titleCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** The value when it is an array, otherwise an empty list (a stray string must not be iterated per character). */
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** Trims, drops empty entries and dedupes case-insensitively, keeping the first spelling and order. */
function uniqueTrimmed(values: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of listOf(values)) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    const folded = value.toLowerCase();
    if (!value || seen.has(folded)) continue;
    seen.add(folded);
    out.push(value);
  }
  return out;
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const nullableTrimmed = (value: unknown): string | null => trimmed(value) || null;

/**
 * Runs `decode` and returns null when the row cannot be decrypted (corrupted blob), so one bad row never stops
 * startup or an export. Other errors still throw.
 */
function decodeOrNull<T>(decode: () => T): T | null {
  try {
    return decode();
  } catch (err) {
    if (err instanceof DecryptionError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MetaRepo
// ---------------------------------------------------------------------------

/** Plain-text key/value store for non-sensitive metadata (schema_version, recovery_ack, ...). */
export class MetaRepo {
  private readonly stmt: (sql: string) => StatementSync;

  constructor(private readonly db: Db) {
    this.stmt = statementCache(db);
  }

  get(key: string): string | null {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.stmt('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  delete(key: string): void {
    this.stmt('DELETE FROM meta WHERE key = ?').run(key);
  }
}

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

const TITLE_MAX = 200;
const BODY_MAX = 20000;
const CHANGE_NOTE_MAX = 500;

const FACT_STATUSES: ReadonlySet<FactStatus> = new Set<FactStatus>(['unchecked', 'verified', 'outdated', 'contradicted', 'unverifiable']);

const isFactStatus = (value: unknown): value is FactStatus => typeof value === 'string' && FACT_STATUSES.has(value as FactStatus);

/**
 * Canonical content used for versioning + HMAC fingerprint: trims title/body/notes/shortcut, dedupes and
 * trims tags/intents/triggers (keeping order), and returns an object with keys in a fixed order.
 * Tags and triggers are deduped case-insensitively (first spelling wins); unknown intents are dropped;
 * an empty categoryId becomes null.
 */
export function canonicalContent(input: MacroContent): MacroContent {
  return {
    title: trimmed(input.title),
    body: trimmed(input.body),
    categoryId: nullableTrimmed(input.categoryId),
    tags: uniqueTrimmed(input.tags),
    intents: [...new Set(listOf(input.intents).map(trimmed).filter(isIntent))],
    triggers: uniqueTrimmed(input.triggers),
    notes: trimmed(input.notes),
    shortcut: trimmed(input.shortcut),
  };
}

/** Canonicalizes and validates editable macro content; throws a user-facing Error when invalid. */
function validateContent(input: MacroContent): MacroContent {
  const content = canonicalContent(input);
  if (!content.title) throw new Error('Title is required');
  if (!content.body) throw new Error('Body is required');
  if (content.title.length > TITLE_MAX) throw new Error(`Title must be at most ${TITLE_MAX} characters`);
  if (content.body.length > BODY_MAX) throw new Error(`Body must be at most ${BODY_MAX} characters`);
  return content;
}

interface MacroRow {
  id: Id;
  current_version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  is_favorite: number;
  use_count: number;
  last_used_at: string | null;
  verification: VerificationStatus;
  payload: Uint8Array;
}

interface FactRow {
  id: Id;
  macro_id: Id;
  status: FactStatus;
  last_checked_at: string | null;
  payload: Uint8Array;
}

interface VersionRow {
  version: number;
  created_at: string;
  change_source: ChangeSource;
  payload: Uint8Array;
}

interface VersionPayload {
  content: MacroContent;
  changeNote: string;
}

type FactPayload = Pick<Fact, 'key' | 'statement' | 'value' | 'sourceUrl' | 'evidenceQuote'>;

const MACRO_COLUMNS = `m.id, m.current_version, m.created_at, m.updated_at, m.archived_at, m.is_favorite,
  m.use_count, m.last_used_at, m.verification, v.payload`;
const MACRO_FROM = 'FROM macros m JOIN macro_versions v ON v.macro_id = m.id AND v.version = m.current_version';

const SQL = {
  listMacros: `SELECT ${MACRO_COLUMNS} ${MACRO_FROM} WHERE m.archived_at IS NULL`,
  listMacrosAll: `SELECT ${MACRO_COLUMNS} ${MACRO_FROM}`,
  listFacts: `SELECT f.id, f.macro_id, f.status, f.last_checked_at, f.payload FROM facts f
    JOIN macros m ON m.id = f.macro_id WHERE m.archived_at IS NULL ORDER BY f.macro_id, f.sort`,
  listFactsAll: 'SELECT id, macro_id, status, last_checked_at, payload FROM facts ORDER BY macro_id, sort',
  getMacro: `SELECT ${MACRO_COLUMNS} ${MACRO_FROM} WHERE m.id = ?`,
  factsOf: 'SELECT id, macro_id, status, last_checked_at, payload FROM facts WHERE macro_id = ? ORDER BY sort',
  currentVersion: `SELECT m.current_version AS version, v.content_hmac ${MACRO_FROM} WHERE m.id = ?`,
  insertMacro: `INSERT INTO macros (id, current_version, created_at, updated_at, verification)
    VALUES (?, 1, ?, ?, 'unverified')`,
  insertVersion: `INSERT INTO macro_versions (macro_id, version, created_at, change_source, content_hmac, payload)
    VALUES (?, ?, ?, ?, ?, ?)`,
  setCurrentVersion: 'UPDATE macros SET current_version = ?, updated_at = ? WHERE id = ?',
  archive: 'UPDATE macros SET archived_at = COALESCE(archived_at, ?) WHERE id = ?',
  restore: 'UPDATE macros SET archived_at = NULL WHERE id = ?',
  deleteMacro: 'DELETE FROM macros WHERE id = ?',
  setFavorite: 'UPDATE macros SET is_favorite = ? WHERE id = ?',
  recordUse: 'UPDATE macros SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
  listVersions: `SELECT version, created_at, change_source, payload FROM macro_versions
    WHERE macro_id = ? ORDER BY version DESC`,
  getVersion: `SELECT version, created_at, change_source, payload FROM macro_versions
    WHERE macro_id = ? AND version = ?`,
  factStatesOf: 'SELECT id, status, last_checked_at FROM facts WHERE macro_id = ?',
  updateFact: 'UPDATE facts SET sort = ?, status = ?, last_checked_at = ?, payload = ? WHERE id = ?',
  insertFact: 'INSERT INTO facts (id, macro_id, sort, status, last_checked_at, payload) VALUES (?, ?, ?, ?, ?, ?)',
  deleteFact: 'DELETE FROM facts WHERE id = ?',
  factMacro: 'SELECT macro_id FROM facts WHERE id = ?',
  setFactStatus: 'UPDATE facts SET status = ?, last_checked_at = ? WHERE id = ?',
  statusesOf: 'SELECT status FROM facts WHERE macro_id = ?',
  setVerification: 'UPDATE macros SET verification = ? WHERE id = ?',
  macroExists: 'SELECT 1 AS found FROM macros WHERE id = ?',
  currentContentKeys: `SELECT v.content_hmac ${MACRO_FROM}`,
} as const;

const versionAad = (macroId: Id, version: number): string => `macro_versions:${macroId}:${version}`;
const factAad = (factId: Id): string => `facts:${factId}`;

function factPayload(input: FactInput): FactPayload {
  return {
    key: trimmed(input.key),
    statement: trimmed(input.statement),
    value: trimmed(input.value),
    sourceUrl: nullableTrimmed(input.sourceUrl),
    evidenceQuote: nullableTrimmed(input.evidenceQuote),
  };
}

/** last_checked_at after an explicit status change: unchecked means "never checked". */
const checkedAtFor = (status: FactStatus, now: string): string | null => (status === 'unchecked' ? null : now);

/** Macros with encrypted, versioned content and per-macro facts (macros, macro_versions, facts tables). */
export class MacroRepo {
  private readonly stmt: (sql: string) => StatementSync;
  /** Macros whose current content or one of whose facts could not be decrypted when last read (see unreadableIds). */
  private readonly unreadable = new Set<Id>();

  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {
    this.stmt = statementCache(db);
  }

  /**
   * All macros with current content + facts, decrypted. Archived excluded unless includeArchived. Sorted by title
   * (case-insensitive). A macro whose current version cannot be decrypted is left out and a fact that cannot be
   * decrypted is dropped from its macro; both are recorded in unreadableIds() (ids only, never content).
   */
  listAll(opts?: { includeArchived?: boolean }): Macro[] {
    const all = opts?.includeArchived === true;
    const rows = this.stmt(all ? SQL.listMacrosAll : SQL.listMacros).all() as unknown as MacroRow[];
    const factRows = this.stmt(all ? SQL.listFactsAll : SQL.listFacts).all() as unknown as FactRow[];
    const failed = new Set<Id>();
    const factsByMacro = new Map<Id, Fact[]>();
    for (const row of factRows) {
      const fact = decodeOrNull(() => this.toFact(row));
      if (!fact) {
        failed.add(row.macro_id);
        continue;
      }
      let list = factsByMacro.get(row.macro_id);
      if (!list) {
        list = [];
        factsByMacro.set(row.macro_id, list);
      }
      list.push(fact);
    }
    const macros: Macro[] = [];
    for (const row of rows) {
      const macro = decodeOrNull(() => this.toMacro(row, factsByMacro.get(row.id) ?? []));
      if (macro) macros.push(macro);
      else failed.add(row.id);
    }
    if (all) this.unreadable.clear();
    else for (const row of rows) this.unreadable.delete(row.id);
    for (const id of failed) this.unreadable.add(id);
    return macros.sort((a, b) => titleCollator.compare(a.title, b.title) || (a.id < b.id ? -1 : 1));
  }

  /** The macro, or null when it does not exist or its current version cannot be decrypted (see unreadableIds). */
  get(id: Id): Macro | null {
    const row = this.stmt(SQL.getMacro).get(id) as unknown as MacroRow | undefined;
    if (!row) return null;
    let readable = true;
    const facts: Fact[] = [];
    for (const factRow of this.stmt(SQL.factsOf).all(id) as unknown as FactRow[]) {
      const fact = decodeOrNull(() => this.toFact(factRow));
      if (fact) facts.push(fact);
      else readable = false;
    }
    const macro = decodeOrNull(() => this.toMacro(row, facts));
    if (macro && readable) this.unreadable.delete(id);
    else this.unreadable.add(id);
    return macro;
  }

  /**
   * Ids of macros found corrupted by the latest reads: their current content could not be decrypted (the macro is
   * skipped) or one of their facts could not (the fact is skipped). Saving new content or facts repairs a macro.
   */
  unreadableIds(): Id[] {
    return [...this.unreadable];
  }

  /** HMAC of the current version's canonical content (used as embedding cache key). */
  contentKey(id: Id): string | null {
    return this.currentVersion(id)?.content_hmac ?? null;
  }

  /** Current content HMAC of every macro, archived and unreadable ones included (no decryption needed). */
  currentContentKeys(): string[] {
    return (this.stmt(SQL.currentContentKeys).all() as { content_hmac: string }[]).map((row) => row.content_hmac);
  }

  /**
   * Embedding vectors are derived from macro content, so they go with it: drops cached vectors (every model) whose
   * key is not in `keep` (see EmbeddingRepo.pruneExcept). Returns the number of rows deleted.
   */
  pruneEmbeddings(keep: ReadonlySet<string>, onlyModel?: string): number {
    return new EmbeddingRepo(this.db, this.cipher).pruneExcept(keep, onlyModel);
  }

  /** Create macro (version 1) + facts in one transaction. `at` lets seed/import set a timestamp. */
  create(input: MacroInput, source: ChangeSource, at?: Date): Macro {
    const content = validateContent(input);
    const id = randomUUID();
    const now = iso(at);
    this.db.tx(() => {
      this.stmt(SQL.insertMacro).run(id, now, now);
      this.insertVersion(id, 1, content, this.fingerprint(content), source, input.changeNote, now);
      if (input.facts?.length) this.replaceFacts(id, input.facts);
    });
    return this.require(id);
  }

  /**
   * Save new content as a new version (source e.g. 'manual'). If the canonical content is identical to the
   * current version, no version is created. If input.facts is provided, facts are replaced (see replaceFacts).
   * Throws Error('Macro not found') for unknown ids.
   */
  update(id: Id, input: MacroInput, source: ChangeSource): Macro {
    this.db.tx(() => {
      const current = this.currentVersion(id);
      if (!current) throw new Error('Macro not found');
      const content = validateContent(input);
      const hmac = this.fingerprint(content);
      if (hmac !== current.content_hmac) this.appendVersion(id, current.version + 1, content, hmac, source, input.changeNote);
      if (input.facts) this.replaceFacts(id, input.facts);
    });
    return this.require(id);
  }

  /** Soft delete (sets archived_at; archiving twice keeps the first timestamp). */
  archive(id: Id): void {
    this.mustChange(this.stmt(SQL.archive).run(iso(), id).changes);
  }

  restore(id: Id): Macro {
    this.mustChange(this.stmt(SQL.restore).run(id).changes);
    return this.require(id);
  }

  /**
   * Permanent delete (macro, versions, facts). Versions, facts and their dependent rows go with the macro via
   * ON DELETE CASCADE (openDatabase enables foreign keys). Throws Error('Macro not found') for unknown ids.
   */
  hardDelete(id: Id): void {
    this.mustChange(this.stmt(SQL.deleteMacro).run(id).changes);
    this.unreadable.delete(id);
  }

  setFavorite(id: Id, favorite: boolean): Macro {
    this.mustChange(this.stmt(SQL.setFavorite).run(favorite ? 1 : 0, id).changes);
    return this.require(id);
  }

  /** use_count += 1, last_used_at = at. Unknown ids are ignored (the macro may have been deleted meanwhile). */
  recordUse(id: Id, at?: Date): void {
    this.stmt(SQL.recordUse).run(iso(at), id);
  }

  /** Newest first. Versions that cannot be decrypted (corrupted rows) are left out. */
  listVersions(id: Id): MacroVersion[] {
    const rows = this.stmt(SQL.listVersions).all(id) as unknown as VersionRow[];
    return rows.flatMap((row) => decodeOrNull(() => this.toVersion(id, row)) ?? []);
  }

  /**
   * Create a new version whose content equals `version`'s content (change_source 'revert').
   * Reverting to content identical to the current version creates no version (same rule as update()).
   * Throws Error('Macro not found') / Error('Version not found').
   */
  revert(id: Id, version: number): Macro {
    this.db.tx(() => {
      const current = this.currentVersion(id);
      if (!current) throw new Error('Macro not found');
      const target = this.stmt(SQL.getVersion).get(id, version) as unknown as VersionRow | undefined;
      if (!target) throw new Error('Version not found');
      const content = canonicalContent(this.toVersion(id, target).content);
      const hmac = this.fingerprint(content);
      if (hmac === current.content_hmac) return;
      this.appendVersion(id, current.version + 1, content, hmac, 'revert', `Reverted to version ${version}`);
    });
    return this.require(id);
  }

  /**
   * Replace the macro's fact list. Facts with an `id` that exists for this macro are updated in place
   * (keeping status/last_checked_at unless input.status is given); others are inserted (status from input or
   * 'unchecked'); facts not in the list are deleted. Recomputes macros.verification with rollupVerification().
   * Returns the new fact list in input order.
   */
  replaceFacts(id: Id, facts: FactInput[]): Fact[] {
    return this.db.tx(() => {
      if (!this.stmt(SQL.macroExists).get(id)) throw new Error('Macro not found');
      const existing = new Map(
        (this.stmt(SQL.factStatesOf).all(id) as unknown as Pick<FactRow, 'id' | 'status' | 'last_checked_at'>[]).map((row) => [row.id, row]),
      );
      const now = iso();
      const result = facts.map((input, sort) => {
        const prior = input.id ? existing.get(input.id) : undefined;
        if (prior) existing.delete(prior.id);
        return prior ? this.updateFact(id, prior, input, sort, now) : this.insertFact(id, input, sort, now);
      });
      for (const staleId of existing.keys()) this.stmt(SQL.deleteFact).run(staleId);
      this.stmt(SQL.setVerification).run(rollupVerification(result.map((f) => f.status)), id);
      return result;
    });
  }

  /**
   * Update one fact's status (used by accuracy checks). Recomputes the macro's verification.
   * last_checked_at becomes `checkedAt` (default now), or null for 'unchecked'. Throws Error('Fact not found').
   */
  setFactStatus(factId: Id, status: Fact['status'], checkedAt?: Date): void {
    if (!isFactStatus(status)) throw new Error('Invalid fact status');
    this.db.tx(() => {
      const row = this.stmt(SQL.factMacro).get(factId) as { macro_id: Id } | undefined;
      if (!row) throw new Error('Fact not found');
      this.stmt(SQL.setFactStatus).run(status, checkedAtFor(status, iso(checkedAt)), factId);
      this.refreshVerification(row.macro_id);
    });
  }

  // -- internals -------------------------------------------------------------

  private currentVersion(id: Id): { version: number; content_hmac: string } | undefined {
    return this.stmt(SQL.currentVersion).get(id) as { version: number; content_hmac: string } | undefined;
  }

  private require(id: Id): Macro {
    const macro = this.get(id);
    if (!macro) throw new Error('Macro not found');
    return macro;
  }

  private mustChange(changes: number | bigint): void {
    if (Number(changes) === 0) throw new Error('Macro not found');
  }

  /** content_hmac of canonical content (keys are already in canonical order). */
  private fingerprint(content: MacroContent): string {
    return this.cipher.hmac(JSON.stringify(content));
  }

  private insertVersion(
    id: Id,
    version: number,
    content: MacroContent,
    contentHmac: string,
    source: ChangeSource,
    changeNote: string | undefined,
    now: string,
  ): void {
    const payload: VersionPayload = { content, changeNote: trimmed(changeNote).slice(0, CHANGE_NOTE_MAX) };
    this.stmt(SQL.insertVersion).run(id, version, now, source, contentHmac, this.cipher.encryptJson(payload, versionAad(id, version)));
  }

  /** Inserts the next version and points the macro at it (caller holds the transaction). */
  private appendVersion(id: Id, version: number, content: MacroContent, contentHmac: string, source: ChangeSource, changeNote: string | undefined): void {
    const now = iso();
    this.insertVersion(id, version, content, contentHmac, source, changeNote, now);
    this.stmt(SQL.setCurrentVersion).run(version, now, id);
  }

  private updateFact(macroId: Id, prior: Pick<FactRow, 'id' | 'status' | 'last_checked_at'>, input: FactInput, sort: number, now: string): Fact {
    const payload = factPayload(input);
    const statusChanged = isFactStatus(input.status) && input.status !== prior.status;
    const status = statusChanged ? (input.status as FactStatus) : prior.status;
    const lastCheckedAt = statusChanged ? checkedAtFor(status, now) : prior.last_checked_at;
    this.stmt(SQL.updateFact).run(sort, status, lastCheckedAt, this.cipher.encryptJson(payload, factAad(prior.id)), prior.id);
    return { id: prior.id, macroId, status, lastCheckedAt, ...payload };
  }

  private insertFact(macroId: Id, input: FactInput, sort: number, now: string): Fact {
    const id = randomUUID();
    const payload = factPayload(input);
    const status: FactStatus = isFactStatus(input.status) ? input.status : 'unchecked';
    const lastCheckedAt = checkedAtFor(status, now);
    this.stmt(SQL.insertFact).run(id, macroId, sort, status, lastCheckedAt, this.cipher.encryptJson(payload, factAad(id)));
    return { id, macroId, status, lastCheckedAt, ...payload };
  }

  private refreshVerification(macroId: Id): void {
    const statuses = (this.stmt(SQL.statusesOf).all(macroId) as { status: FactStatus }[]).map((r) => r.status);
    this.stmt(SQL.setVerification).run(rollupVerification(statuses), macroId);
  }

  private toFact(row: FactRow): Fact {
    const payload = this.cipher.decryptJson<FactPayload>(row.payload, factAad(row.id));
    return { id: row.id, macroId: row.macro_id, status: row.status, lastCheckedAt: row.last_checked_at, ...payload };
  }

  private toVersion(macroId: Id, row: VersionRow): MacroVersion {
    const payload = this.cipher.decryptJson<VersionPayload>(row.payload, versionAad(macroId, row.version));
    return {
      macroId,
      version: row.version,
      createdAt: row.created_at,
      changeSource: row.change_source,
      changeNote: payload.changeNote,
      content: payload.content,
    };
  }

  private toMacro(row: MacroRow, facts: Fact[]): Macro {
    const { content } = this.cipher.decryptJson<VersionPayload>(row.payload, versionAad(row.id, row.current_version));
    return {
      ...content,
      id: row.id,
      version: row.current_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      isFavorite: row.is_favorite === 1,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      verification: row.verification,
      facts,
    };
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const DEFAULT_CATEGORY_COLOR = '#4f7cff';
const CATEGORY_NAME_MAX = 100;
const CATEGORY_COLOR_MAX = 50;

interface CategoryRow {
  id: Id;
  sort: number;
  payload: Uint8Array;
}

type CategoryPayload = Pick<Category, 'name' | 'color'>;

const categoryAad = (id: Id): string => `categories:${id}`;

const normalizeSort = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;

function categoryName(value: unknown): string {
  const name = trimmed(value);
  if (!name) throw new Error('Name is required');
  if (name.length > CATEGORY_NAME_MAX) throw new Error(`Name must be at most ${CATEGORY_NAME_MAX} characters`);
  return name;
}

/** Macro categories with encrypted name/color; names are unique case-insensitively. */
export class CategoryRepo {
  private readonly stmt: (sql: string) => StatementSync;
  private readonly unreadable = new Set<Id>();

  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {
    this.stmt = statementCache(db);
  }

  /** Sorted by sort, then name. Categories that cannot be decrypted are left out (see unreadableIds). */
  list(): Category[] {
    const rows = this.stmt('SELECT id, sort, payload FROM categories').all() as unknown as CategoryRow[];
    const categories: Category[] = [];
    this.unreadable.clear();
    for (const row of rows) {
      const category = decodeOrNull(() => this.toCategory(row));
      if (category) categories.push(category);
      else this.unreadable.add(row.id);
    }
    return categories.sort((a, b) => a.sort - b.sort || titleCollator.compare(a.name, b.name));
  }

  /** Ids of categories whose row could not be decrypted by the latest list(). */
  unreadableIds(): Id[] {
    return [...this.unreadable];
  }

  /** Throws Error('Name is required') or Error('Category name must be unique') (case-insensitive; the message maps to HTTP 400). */
  create(input: CategoryInput): Category {
    const name = categoryName(input.name);
    return this.db.tx(() => {
      this.assertUniqueName(name, null);
      const category: Category = {
        id: randomUUID(),
        name,
        color: trimmed(input.color).slice(0, CATEGORY_COLOR_MAX) || DEFAULT_CATEGORY_COLOR,
        sort: normalizeSort(input.sort, 0),
      };
      this.stmt('INSERT INTO categories (id, sort, created_at, payload) VALUES (?, ?, ?, ?)').run(
        category.id,
        category.sort,
        iso(),
        this.encrypt(category),
      );
      return category;
    });
  }

  /** Omitted color/sort keep their current values. Throws Error('Category not found'). */
  update(id: Id, input: CategoryInput): Category {
    const name = categoryName(input.name);
    return this.db.tx(() => {
      const row = this.stmt('SELECT id, sort, payload FROM categories WHERE id = ?').get(id) as unknown as CategoryRow | undefined;
      if (!row) throw new Error('Category not found');
      this.assertUniqueName(name, id);
      const current = this.toCategory(row);
      const category: Category = {
        id,
        name,
        color: trimmed(input.color).slice(0, CATEGORY_COLOR_MAX) || current.color,
        sort: normalizeSort(input.sort, current.sort),
      };
      this.stmt('UPDATE categories SET sort = ?, payload = ? WHERE id = ?').run(category.sort, this.encrypt(category), id);
      return category;
    });
  }

  /** Deletes the category; macros keep a dangling categoryId which the app treats as "no category". Throws Error('Category not found'). */
  delete(id: Id): void {
    const { changes } = this.stmt('DELETE FROM categories WHERE id = ?').run(id);
    if (Number(changes) === 0) throw new Error('Category not found');
  }

  /**
   * Case-insensitive lookup by name; creates the category when missing (used by import/seed), with `color` when
   * given (an existing category keeps its color).
   */
  ensureByName(name: string, color?: string | null): Category {
    const wanted = categoryName(name);
    return this.db.tx(() => this.findByName(wanted) ?? this.create({ name: wanted, color: color ?? undefined }));
  }

  private findByName(name: string): Category | undefined {
    const folded = name.toLowerCase();
    return this.list().find((c) => c.name.toLowerCase() === folded);
  }

  private assertUniqueName(name: string, selfId: Id | null): void {
    const clash = this.findByName(name);
    if (clash && clash.id !== selfId) throw new Error('Category name must be unique');
  }

  private encrypt(category: Category): Buffer {
    const payload: CategoryPayload = { name: category.name, color: category.color };
    return this.cipher.encryptJson(payload, categoryAad(category.id));
  }

  private toCategory(row: CategoryRow): Category {
    const payload = this.cipher.decryptJson<CategoryPayload>(row.payload, categoryAad(row.id));
    return { id: row.id, name: payload.name, color: payload.color, sort: row.sort };
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const APP_SETTINGS_KEY = 'app';
const ANTHROPIC_SECRET = 'anthropic_api_key';
const SETTINGS_STRING_MAX = 500;

type LeafRule =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'number'; min: number; max: number; integer?: boolean }
  | { kind: 'string'; required?: boolean };

/** Validation rules by dotted path. Leaves without a rule only need the default's primitive type. */
const SETTINGS_RULES: Readonly<Record<string, LeafRule>> = {
  'ai.provider': { kind: 'enum', values: ['none', 'anthropic', 'ollama'] },
  'ai.effort': { kind: 'enum', values: ['low', 'medium', 'high'] },
  'embeddings.provider': { kind: 'enum', values: ['auto', 'builtin', 'transformers', 'ollama'] },
  'ui.theme': { kind: 'enum', values: ['system', 'light', 'dark'] },
  'recommendation.minConfidence': { kind: 'number', min: 0, max: 100 },
  'recommendation.maxResults': { kind: 'number', min: 1, max: 3, integer: true },
  'accuracy.intervalHours': { kind: 'number', min: 6, max: 720 },
  'ai.monthlyBudgetUsd': { kind: 'number', min: 0, max: 1000 },
  'privacy.analyticsRetentionDays': { kind: 'number', min: 1, max: 3650, integer: true },
  'ai.anthropicModel': { kind: 'string', required: true },
  'ai.ollamaUrl': { kind: 'string', required: true },
  'ai.ollamaModel': { kind: 'string', required: true },
  'embeddings.ollamaModel': { kind: 'string', required: true },
};

/** Derived (never stored, never patchable) settings paths. */
const DERIVED_SETTINGS = new Set(['ai.anthropicKeySet']);

type JsonObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns the validated leaf value, or undefined when the candidate must be ignored. */
function sanitizeLeaf(path: string, base: unknown, candidate: unknown): unknown {
  if (typeof candidate !== typeof base) return undefined;
  const rule = SETTINGS_RULES[path];
  if (typeof candidate === 'number') {
    if (!Number.isFinite(candidate)) return undefined;
    if (rule?.kind !== 'number') return candidate;
    const clamped = Math.min(rule.max, Math.max(rule.min, candidate));
    return rule.integer ? Math.round(clamped) : clamped;
  }
  if (typeof candidate === 'string') {
    const value = candidate.trim().slice(0, SETTINGS_STRING_MAX);
    if (rule?.kind === 'enum') return rule.values.includes(value) ? value : undefined;
    return rule?.kind === 'string' && rule.required && !value ? undefined : value;
  }
  return candidate;
}

/**
 * Returns a fresh copy of `base` with every known key of `patch` applied when it passes validation.
 * Only keys present in `base` are considered, so unknown keys (and prototype tricks) are ignored.
 */
function mergeKnown(base: JsonObject, patch: unknown, prefix = ''): JsonObject {
  const source = isPlainObject(patch) ? patch : {};
  const out: JsonObject = {};
  for (const [key, baseValue] of Object.entries(base)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const candidate = Object.hasOwn(source, key) && !DERIVED_SETTINGS.has(path) ? source[key] : undefined;
    if (isPlainObject(baseValue)) {
      out[key] = mergeKnown(baseValue, candidate, path);
      continue;
    }
    const value = candidate === undefined ? undefined : sanitizeLeaf(path, baseValue, candidate);
    out[key] = value === undefined ? baseValue : value;
  }
  return out;
}

const settingsAad = (key: string): string => `settings:${key}`;
const secretKey = (name: string): string => `secret:${name}`;

/** Settings are stored encrypted as one JSON document under key 'app'; secrets under 'secret:<name>'. */
export class SettingsRepo {
  private readonly stmt: (sql: string) => StatementSync;

  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {
    this.stmt = statementCache(db);
  }

  /** Stored settings deep-merged over DEFAULT_SETTINGS; anthropicKeySet reflects whether the secret exists. */
  get(): AppSettings {
    const stored = this.readJson<unknown>(APP_SETTINGS_KEY);
    return this.withDerived(mergeKnown(DEFAULT_SETTINGS as unknown as JsonObject, stored));
  }

  /** Deep-merge patch, validate ranges (clamp numbers, ignore unknown keys / wrong types), persist, return result. */
  update(patch: DeepPartial<AppSettings>): AppSettings {
    return this.db.tx(() => {
      const next = mergeKnown(this.get() as unknown as JsonObject, patch);
      const ai: Partial<AppSettings['ai']> = { ...(next.ai as AppSettings['ai']) };
      delete ai.anthropicKeySet;
      this.writeJson(APP_SETTINGS_KEY, { ...next, ai });
      return this.withDerived(next);
    });
  }

  getSecret(name: string): string | null {
    return this.readJson<string>(secretKey(name));
  }

  /** null (or an empty string) deletes the secret. */
  setSecret(name: string, value: string | null): void {
    if (!name) throw new Error('Secret name is required');
    const key = secretKey(name);
    if (value) this.writeJson(key, value);
    else this.stmt('DELETE FROM settings WHERE key = ?').run(key);
  }

  private withDerived(settings: JsonObject): AppSettings {
    const result = settings as unknown as AppSettings;
    result.ai.anthropicKeySet = this.stmt('SELECT 1 AS found FROM settings WHERE key = ?').get(secretKey(ANTHROPIC_SECRET)) !== undefined;
    return result;
  }

  private readJson<T>(key: string): T | null {
    const row = this.stmt('SELECT payload FROM settings WHERE key = ?').get(key) as { payload: Uint8Array } | undefined;
    return row ? this.cipher.decryptJson<T>(row.payload, settingsAad(key)) : null;
  }

  private writeJson(key: string, value: unknown): void {
    this.stmt('INSERT INTO settings (key, payload) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload').run(
      key,
      this.cipher.encryptJson(value, settingsAad(key)),
    );
  }
}

// ---------------------------------------------------------------------------
// Usage events
// ---------------------------------------------------------------------------

/** A usage event as read back from the database. */
export interface StoredEvent extends UsageEventInput {
  uid: string;
  ts: string;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<UsageEventType>(['recommendation_shown', 'recommendation_selected', 'reply_copied', 'no_match']);
const PERSONALIZE_MODES: ReadonlySet<string> = new Set<PersonalizeMode>(['fast', 'ai']);
const DAY_MS = 86_400_000;

const finiteOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Copies only the whitelisted, non-textual event fields so customer text can never be persisted. */
function sanitizeEvent(event: UsageEventInput): UsageEventInput {
  if (!EVENT_TYPES.has(event.type)) throw new Error('Unknown event type');
  const out: UsageEventInput = { type: event.type };
  if (Array.isArray(event.macroIds)) out.macroIds = event.macroIds.filter((id): id is Id => typeof id === 'string');
  const rank = finiteOrUndefined(event.rank);
  if (rank !== undefined) out.rank = rank;
  const confidence = finiteOrUndefined(event.confidence);
  if (confidence !== undefined) out.confidence = confidence;
  if (Array.isArray(event.intents)) out.intents = event.intents.filter(isIntent);
  const editRatio = finiteOrUndefined(event.editRatio);
  if (editRatio !== undefined) out.editRatio = editRatio;
  if (typeof event.mode === 'string' && PERSONALIZE_MODES.has(event.mode)) out.mode = event.mode;
  return out;
}

const eventAad = (uid: string): string => `events:${uid}`;

/** Encrypted analytics events (whitelisted ids, numbers and enums only; never customer text). */
export class EventRepo {
  private readonly stmt: (sql: string) => StatementSync;

  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {
    this.stmt = statementCache(db);
  }

  /** Stores a usage event (only whitelisted numeric/id/enum fields). Throws Error('Unknown event type'). */
  add(event: UsageEventInput, at?: Date): void {
    const payload = sanitizeEvent(event);
    const uid = randomUUID();
    this.stmt('INSERT INTO events (uid, ts, type, payload) VALUES (?, ?, ?, ?)').run(
      uid,
      iso(at),
      payload.type,
      this.cipher.encryptJson(payload, eventAad(uid)),
    );
  }

  /**
   * Events oldest first (insertion order for equal timestamps), optionally only those at/after `since` and/or
   * of one type. Ordering by (ts, rowid) follows idx_events_ts, so no sort step is needed.
   */
  list(opts?: { since?: Date; type?: UsageEventType }): StoredEvent[] {
    const rows = this.stmt(
      "SELECT uid, ts, payload FROM events WHERE ts >= :since AND (:type = '' OR type = :type) ORDER BY ts, rowid",
    ).all({ since: opts?.since ? iso(opts.since) : '', type: opts?.type ?? '' }) as unknown as { uid: string; ts: string; payload: Uint8Array }[];
    return rows.map((row) => ({ ...this.cipher.decryptJson<UsageEventInput>(row.payload, eventAad(row.uid)), uid: row.uid, ts: row.ts }));
  }

  /** Deletes events older than `days`; returns number deleted. Throws for negative or non-finite `days`. */
  purgeOlderThan(days: number, now?: Date): number {
    if (!Number.isFinite(days) || days < 0) throw new Error('Retention days must be a non-negative number');
    const cutoff = new Date((now ?? new Date()).getTime() - days * DAY_MS).toISOString();
    return Number(this.stmt('DELETE FROM events WHERE ts < ?').run(cutoff).changes);
  }
}

// ---------------------------------------------------------------------------
// LLM usage
// ---------------------------------------------------------------------------

const nonNegative = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** Per-call LLM token and cost accounting used for the monthly budget (no prompt or reply text). */
export class LlmUsageRepo {
  private readonly stmt: (sql: string) => StatementSync;

  constructor(private readonly db: Db) {
    this.stmt = statementCache(db);
  }

  /** Records one LLM call (counts and cost only, never prompt text). Month is derived from the UTC timestamp. */
  record(purpose: string, usage: LlmUsage, at?: Date): void {
    const ts = iso(at);
    this.stmt(
      `INSERT INTO llm_usage (ts, month, provider, model, purpose, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ts,
      ts.slice(0, 7),
      usage.provider,
      usage.model,
      purpose,
      Math.round(nonNegative(usage.inputTokens)),
      Math.round(nonNegative(usage.outputTokens)),
      nonNegative(usage.costUsd),
    );
  }

  /** Totals for a calendar month 'YYYY-MM' (default: current month, UTC). */
  monthTotals(month?: string): { requests: number; inputTokens: number; outputTokens: number; costUsd: number } {
    const row = this.stmt(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens, COALESCE(SUM(cost_usd), 0) AS costUsd
       FROM llm_usage WHERE month = ?`,
    ).get(month ?? iso().slice(0, 7)) as { requests: number; inputTokens: number; outputTokens: number; costUsd: number };
    return { requests: row.requests, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd: row.costUsd };
  }
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

const embeddingAad = (model: string, contentHmac: string): string => `embeddings:${model}:${contentHmac}`;

/** Encrypted cache of embedding vectors keyed by (model, content HMAC). */
export class EmbeddingRepo {
  private readonly stmt: (sql: string) => StatementSync;

  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {
    this.stmt = statementCache(db);
  }

  /** Returns a fresh Float32Array, or null when missing or when the stored length does not match `dim`. */
  get(model: string, contentHmac: string): Float32Array | null {
    const row = this.stmt('SELECT dim, payload FROM embeddings WHERE model = ? AND content_hmac = ?').get(model, contentHmac) as
      | { dim: number; payload: Uint8Array }
      | undefined;
    if (!row) return null;
    const bytes = this.cipher.decrypt(row.payload, embeddingAad(model, contentHmac));
    if (bytes.length !== row.dim * Float32Array.BYTES_PER_ELEMENT) return null;
    const vector = new Float32Array(row.dim);
    new Uint8Array(vector.buffer).set(bytes);
    return vector;
  }

  set(model: string, contentHmac: string, vector: Float32Array): void {
    const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
    this.stmt(
      `INSERT INTO embeddings (model, content_hmac, dim, created_at, payload) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(model, content_hmac) DO UPDATE SET dim = excluded.dim, created_at = excluded.created_at, payload = excluded.payload`,
    ).run(model, contentHmac, vector.length, iso(), this.cipher.encrypt(bytes, embeddingAad(model, contentHmac)));
  }

  /**
   * Delete cached vectors of every model whose content_hmac is not in `keep`; with `onlyModel`, also every vector
   * of other models. Returns count deleted.
   */
  pruneExcept(keep: ReadonlySet<string>, onlyModel?: string): number {
    return this.db.tx(() => {
      const rows = this.stmt('SELECT model, content_hmac FROM embeddings').all() as { model: string; content_hmac: string }[];
      const remove = this.stmt('DELETE FROM embeddings WHERE model = ? AND content_hmac = ?');
      let deleted = 0;
      for (const { model, content_hmac } of rows) {
        if (keep.has(content_hmac) && (onlyModel === undefined || model === onlyModel)) continue;
        deleted += Number(remove.run(model, content_hmac).changes);
      }
      return deleted;
    });
  }

  /** Delete cached vectors whose content_hmac is not in `keep` (for the given model). Returns count deleted. */
  prune(model: string, keep: Set<string>): number {
    return this.db.tx(() => {
      const rows = this.stmt('SELECT content_hmac FROM embeddings WHERE model = ?').all(model) as { content_hmac: string }[];
      const remove = this.stmt('DELETE FROM embeddings WHERE model = ? AND content_hmac = ?');
      let deleted = 0;
      for (const { content_hmac } of rows) {
        if (!keep.has(content_hmac)) deleted += Number(remove.run(model, content_hmac).changes);
      }
      return deleted;
    });
  }
}
