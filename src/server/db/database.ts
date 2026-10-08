import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

export interface Db {
  raw: DatabaseSync;
  /** Run fn inside a transaction (nested calls join the outer transaction). */
  tx<T>(fn: () => T): T;
  close(): void;
}

/** Open (or create) the database file, apply pragmas and pending migrations. Use ':memory:' in tests. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA synchronous = NORMAL;');
  raw.exec('PRAGMA busy_timeout = 3000;');

  let depth = 0;
  const tx = <T>(fn: () => T): T => {
    if (depth > 0) return fn();
    depth++;
    raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      raw.exec('COMMIT');
      return out;
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    } finally {
      depth--;
    }
  };

  raw.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  let current = row ? Number(row.value) : 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    tx(() => {
      raw.exec(m.sql);
      raw.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(m.version));
    });
    current = m.version;
  }

  return { raw, tx, close: () => raw.close() };
}
