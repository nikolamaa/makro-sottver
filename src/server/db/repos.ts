/**
 * Repositories: the only code that touches SQL. All user content is encrypted with the Cipher using the
 * AAD conventions documented in schema.ts. All methods are synchronous (node:sqlite is synchronous and fast).
 * IDs are generated with crypto.randomUUID(). Timestamps are ISO strings (new Date().toISOString()).
 */
import type {
  AppSettings,
  Category,
  CategoryInput,
  ChangeSource,
  DeepPartial,
  Fact,
  FactInput,
  Id,
  LlmUsage,
  Macro,
  MacroContent,
  MacroInput,
  MacroVersion,
  UsageEventInput,
  UsageEventType,
} from '../../shared/types.js';
import type { Cipher } from '../crypto/cipher.js';
import type { Db } from './database.js';

/** Plain-text key/value store for non-sensitive metadata (schema_version, recovery_ack, ...). */
export class MetaRepo {
  constructor(private readonly db: Db) {}
  get(key: string): string | null {
    throw new Error('TODO');
  }
  set(key: string, value: string): void {
    throw new Error('TODO');
  }
  delete(key: string): void {
    throw new Error('TODO');
  }
}

/**
 * Canonical content used for versioning + HMAC fingerprint: trims title/body/notes/shortcut, dedupes and
 * trims tags/intents/triggers (keeping order), and returns an object with keys in a fixed order.
 */
export function canonicalContent(input: MacroContent): MacroContent {
  throw new Error('TODO');
}

export class MacroRepo {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}

  /** All macros with current content + facts, decrypted. Archived excluded unless includeArchived. Sorted by title (case-insensitive). */
  listAll(opts?: { includeArchived?: boolean }): Macro[] {
    throw new Error('TODO');
  }

  get(id: Id): Macro | null {
    throw new Error('TODO');
  }

  /** HMAC of the current version's canonical content (used as embedding cache key). */
  contentKey(id: Id): string | null {
    throw new Error('TODO');
  }

  /** Create macro (version 1) + facts in one transaction. `at` lets seed/import set a timestamp. */
  create(input: MacroInput, source: ChangeSource, at?: Date): Macro {
    throw new Error('TODO');
  }

  /**
   * Save new content as a new version (source e.g. 'manual'). If the canonical content is identical to the
   * current version, no version is created. If input.facts is provided, facts are replaced (see replaceFacts).
   * Throws Error('Macro not found') for unknown ids.
   */
  update(id: Id, input: MacroInput, source: ChangeSource): Macro {
    throw new Error('TODO');
  }

  /** Soft delete (sets archived_at). */
  archive(id: Id): void {
    throw new Error('TODO');
  }

  restore(id: Id): Macro {
    throw new Error('TODO');
  }

  /** Permanent delete (macro, versions, facts). */
  hardDelete(id: Id): void {
    throw new Error('TODO');
  }

  setFavorite(id: Id, favorite: boolean): Macro {
    throw new Error('TODO');
  }

  /** use_count += 1, last_used_at = at. */
  recordUse(id: Id, at?: Date): void {
    throw new Error('TODO');
  }

  /** Newest first. */
  listVersions(id: Id): MacroVersion[] {
    throw new Error('TODO');
  }

  /** Create a new version whose content equals `version`'s content (change_source 'revert'). */
  revert(id: Id, version: number): Macro {
    throw new Error('TODO');
  }

  /**
   * Replace the macro's fact list. Facts with an `id` that exists for this macro are updated in place
   * (keeping status/last_checked_at unless input.status is given); others are inserted (status from input or
   * 'unchecked'); facts not in the list are deleted. Recomputes macros.verification with rollupVerification().
   * Returns the new fact list in input order.
   */
  replaceFacts(id: Id, facts: FactInput[]): Fact[] {
    throw new Error('TODO');
  }

  /** Update one fact's status (used by accuracy checks). Recomputes the macro's verification. */
  setFactStatus(factId: Id, status: Fact['status'], checkedAt?: Date): void {
    throw new Error('TODO');
  }
}

export class CategoryRepo {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}
  /** Sorted by sort, then name. */
  list(): Category[] {
    throw new Error('TODO');
  }
  create(input: CategoryInput): Category {
    throw new Error('TODO');
  }
  update(id: Id, input: CategoryInput): Category {
    throw new Error('TODO');
  }
  /** Deletes the category; macros keep a dangling categoryId which the app treats as "no category". */
  delete(id: Id): void {
    throw new Error('TODO');
  }
  /** Case-insensitive lookup by name; creates the category when missing (used by import/seed). */
  ensureByName(name: string): Category {
    throw new Error('TODO');
  }
}

/** Settings are stored encrypted as one JSON document under key 'app'; secrets under 'secret:<name>'. */
export class SettingsRepo {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}
  /** Stored settings deep-merged over DEFAULT_SETTINGS; anthropicKeySet reflects whether the secret exists. */
  get(): AppSettings {
    throw new Error('TODO');
  }
  /** Deep-merge patch, validate ranges (clamp numbers, ignore unknown keys / wrong types), persist, return result. */
  update(patch: DeepPartial<AppSettings>): AppSettings {
    throw new Error('TODO');
  }
  getSecret(name: string): string | null {
    throw new Error('TODO');
  }
  /** null deletes the secret. */
  setSecret(name: string, value: string | null): void {
    throw new Error('TODO');
  }
}

export interface StoredEvent extends UsageEventInput {
  uid: string;
  ts: string;
}

export class EventRepo {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}
  add(event: UsageEventInput, at?: Date): void {
    throw new Error('TODO');
  }
  list(opts?: { since?: Date; type?: UsageEventType }): StoredEvent[] {
    throw new Error('TODO');
  }
  /** Deletes events older than `days`; returns number deleted. */
  purgeOlderThan(days: number, now?: Date): number {
    throw new Error('TODO');
  }
}

export class LlmUsageRepo {
  constructor(private readonly db: Db) {}
  record(purpose: string, usage: LlmUsage, at?: Date): void {
    throw new Error('TODO');
  }
  /** Totals for a calendar month 'YYYY-MM' (default: current month, UTC). */
  monthTotals(month?: string): { requests: number; inputTokens: number; outputTokens: number; costUsd: number } {
    throw new Error('TODO');
  }
}

/** Encrypted cache of embedding vectors keyed by (model, content HMAC). */
export class EmbeddingRepo {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
  ) {}
  get(model: string, contentHmac: string): Float32Array | null {
    throw new Error('TODO');
  }
  set(model: string, contentHmac: string, vector: Float32Array): void {
    throw new Error('TODO');
  }
  /** Delete cached vectors whose content_hmac is not in `keep` (for the given model). Returns count deleted. */
  prune(model: string, keep: Set<string>): number {
    throw new Error('TODO');
  }
}
