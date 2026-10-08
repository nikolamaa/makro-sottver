import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type FactInput, type LlmUsage, type MacroInput } from '../../shared/types.js';
import { createCipher, DecryptionError, type Cipher } from '../crypto/cipher.js';
import { openDatabase, type Db } from './database.js';
import {
  canonicalContent,
  CategoryRepo,
  EmbeddingRepo,
  EventRepo,
  LlmUsageRepo,
  MacroRepo,
  MetaRepo,
  SettingsRepo,
} from './repos.js';

function macroInput(overrides: Partial<MacroInput> = {}): MacroInput {
  return {
    title: 'Pending withdrawal',
    body: 'Hi {{user}}, your withdrawal of {{amount}} {{currency}} is being processed.',
    categoryId: null,
    tags: ['withdrawal'],
    intents: ['withdrawal_pending'],
    triggers: ['where is my withdrawal'],
    notes: '',
    shortcut: 'wd-pending',
    ...overrides,
  };
}

function fact(overrides: Partial<FactInput> = {}): FactInput {
  return {
    key: 'crypto.withdrawal.min_btc',
    statement: 'Minimum BTC withdrawal is 0.0002 BTC',
    value: '0.0002 BTC',
    sourceUrl: 'https://help.stake.com/en/',
    evidenceQuote: null,
    ...overrides,
  };
}

const usage = (costUsd: number, inputTokens = 100, outputTokens = 50): LlmUsage => ({
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  inputTokens,
  outputTokens,
  costUsd,
  latencyMs: 300,
});

let db: Db;
let cipher: Cipher;

beforeEach(() => {
  db = openDatabase(':memory:');
  cipher = createCipher(randomBytes(32));
});

afterEach(() => db.close());

describe('canonicalContent', () => {
  it('trims, dedupes case-insensitively keeping first spelling and uses a fixed key order', () => {
    const c = canonicalContent({
      shortcut: ' wd ',
      notes: ' n ',
      triggers: [' Where is it ', 'where is it', ''],
      intents: [' general ' as never, 'general', 'not_an_intent' as never, 'GENERAL' as never, 'kyc_verification'],
      tags: ['VIP', 'vip', ' crypto '],
      categoryId: '  ',
      body: '  body  ',
      title: '  Title ',
    });
    expect(c).toEqual({
      title: 'Title',
      body: 'body',
      categoryId: null,
      tags: ['VIP', 'crypto'],
      intents: ['general', 'kyc_verification'],
      triggers: ['Where is it'],
      notes: 'n',
      shortcut: 'wd',
    });
    expect(Object.keys(c)).toEqual(['title', 'body', 'categoryId', 'tags', 'intents', 'triggers', 'notes', 'shortcut']);
  });

  it('treats non-array list fields as empty instead of splitting strings or crashing', () => {
    const c = canonicalContent(macroInput({ tags: 'vip' as never, intents: 'general' as never, triggers: undefined as never }));
    expect(c).toMatchObject({ tags: [], intents: [], triggers: [] });
  });

  it('is idempotent, so the stored content fingerprints the same as LibraryService.keyOf', () => {
    const once = canonicalContent(macroInput({ tags: [' A ', 'a', 'B'], intents: ['general', 'general'] }));
    expect(canonicalContent(once)).toEqual(once);
  });
});

describe('MetaRepo', () => {
  it('gets, sets, overwrites and deletes values', () => {
    const meta = new MetaRepo(db);
    expect(meta.get('recovery_ack')).toBeNull();
    meta.set('recovery_ack', '1');
    meta.set('recovery_ack', '2');
    expect(meta.get('recovery_ack')).toBe('2');
    meta.delete('recovery_ack');
    expect(meta.get('recovery_ack')).toBeNull();
    expect(meta.get('schema_version')).toBe('1');
  });
});

describe('MacroRepo', () => {
  let repo: MacroRepo;
  beforeEach(() => {
    repo = new MacroRepo(db, cipher);
  });

  it('creates a macro with version 1 and normalized content', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    const m = repo.create(
      macroInput({ title: '  Pending withdrawal ', tags: ['a', 'A', ' b ', ''], intents: ['withdrawal_pending', 'bogus' as never], notes: undefined as never }),
      'seed',
      at,
    );
    expect(m.version).toBe(1);
    expect(m.title).toBe('Pending withdrawal');
    expect(m.tags).toEqual(['a', 'b']);
    expect(m.intents).toEqual(['withdrawal_pending']);
    expect(m.notes).toBe('');
    expect(m.createdAt).toBe(at.toISOString());
    expect(m.updatedAt).toBe(at.toISOString());
    expect(m).toMatchObject({ archivedAt: null, isFavorite: false, useCount: 0, lastUsedAt: null, verification: 'unverified', facts: [] });
    expect(repo.get(m.id)).toEqual(m);
    expect(repo.listVersions(m.id)).toEqual([
      expect.objectContaining({ macroId: m.id, version: 1, changeSource: 'seed', changeNote: '', createdAt: at.toISOString() }),
    ]);
  });

  it('validates required fields and lengths', () => {
    expect(() => repo.create(macroInput({ title: '   ' }), 'create')).toThrow('Title is required');
    expect(() => repo.create(macroInput({ body: '\n ' }), 'create')).toThrow('Body is required');
    expect(() => repo.create(macroInput({ title: 'x'.repeat(201) }), 'create')).toThrow(/Title/);
    expect(() => repo.create(macroInput({ body: 'x'.repeat(20001) }), 'create')).toThrow(/Body/);
    expect(repo.create(macroInput({ title: 'x'.repeat(200), body: 'y'.repeat(20000) }), 'create').title).toHaveLength(200);
    const m = repo.create(macroInput(), 'create');
    expect(() => repo.update(m.id, macroInput({ title: '' }), 'manual')).toThrow('Title is required');
    expect(repo.listAll()).toHaveLength(2);
  });

  it('returns null / throws for unknown ids', () => {
    expect(repo.get('nope')).toBeNull();
    expect(repo.contentKey('nope')).toBeNull();
    expect(repo.listVersions('nope')).toEqual([]);
    expect(() => repo.update('nope', macroInput(), 'manual')).toThrow('Macro not found');
    expect(() => repo.archive('nope')).toThrow('Macro not found');
    expect(() => repo.restore('nope')).toThrow('Macro not found');
    expect(() => repo.hardDelete('nope')).toThrow('Macro not found');
    expect(() => repo.setFavorite('nope', true)).toThrow('Macro not found');
    expect(() => repo.revert('nope', 1)).toThrow('Macro not found');
    expect(() => repo.replaceFacts('nope', [])).toThrow('Macro not found');
    expect(() => repo.recordUse('nope')).not.toThrow();
  });

  it('versions content changes and skips identical content', () => {
    const m = repo.create(macroInput(), 'create');
    const key1 = repo.contentKey(m.id);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
    expect(key1).toBe(cipher.hmac(JSON.stringify(canonicalContent(macroInput()))));

    const same = repo.update(m.id, macroInput({ title: ' Pending withdrawal  ', tags: ['withdrawal', 'WITHDRAWAL'] }), 'manual');
    expect(same.version).toBe(1);
    expect(repo.listVersions(m.id)).toHaveLength(1);

    const changed = repo.update(m.id, macroInput({ body: 'New body', changeNote: 'shorter' }), 'manual');
    expect(changed.version).toBe(2);
    expect(changed.body).toBe('New body');
    expect(repo.contentKey(m.id)).not.toBe(key1);
    const versions = repo.listVersions(m.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ changeSource: 'manual', changeNote: 'shorter' });
    expect(versions[1]?.content.body).toBe(macroInput().body);
  });

  it('reverts by creating a new version with the old content', () => {
    const m = repo.create(macroInput(), 'create');
    repo.update(m.id, macroInput({ body: 'v2 body' }), 'manual');
    repo.update(m.id, macroInput({ body: 'v3 body' }), 'manual');
    const reverted = repo.revert(m.id, 1);
    expect(reverted.version).toBe(4);
    expect(reverted.body).toBe(macroInput().body);
    expect(repo.contentKey(m.id)).toBe(cipher.hmac(JSON.stringify(canonicalContent(macroInput()))));
    const versions = repo.listVersions(m.id);
    expect(versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect(versions[0]).toMatchObject({ changeSource: 'revert', changeNote: 'Reverted to version 1' });
    expect(repo.revert(m.id, 4).version).toBe(4);
    expect(() => repo.revert(m.id, 99)).toThrow('Version not found');
  });

  it('archives, restores and lists archived only on request', () => {
    const a = repo.create(macroInput({ title: 'Alpha' }), 'create');
    const b = repo.create(macroInput({ title: 'beta' }), 'create');
    repo.archive(a.id);
    const archivedAt = repo.get(a.id)?.archivedAt;
    expect(archivedAt).toBeTruthy();
    repo.archive(a.id);
    expect(repo.get(a.id)?.archivedAt).toBe(archivedAt);
    expect(repo.listAll().map((m) => m.id)).toEqual([b.id]);
    expect(repo.listAll({ includeArchived: true }).map((m) => m.id)).toEqual([a.id, b.id]);
    expect(repo.restore(a.id).archivedAt).toBeNull();
    expect(repo.listAll()).toHaveLength(2);
  });

  it('hard deletes macro, versions and facts', () => {
    const m = repo.create(macroInput({ facts: [fact(), fact({ key: 'k2' })] }), 'create');
    repo.update(m.id, macroInput({ body: 'v2' }), 'manual');
    const keep = repo.create(macroInput({ title: 'Keep', facts: [fact()] }), 'create');
    repo.hardDelete(m.id);
    expect(repo.get(m.id)).toBeNull();
    const count = (table: string, id: string) =>
      (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE macro_id = ?`).get(id) as { n: number }).n;
    expect(count('macro_versions', m.id)).toBe(0);
    expect(count('facts', m.id)).toBe(0);
    expect(count('facts', keep.id)).toBe(1);
    expect(repo.listAll().map((x) => x.id)).toEqual([keep.id]);
  });

  it('cascades fact and macro deletes to fact checks and update proposals', () => {
    const m = repo.create(macroInput({ facts: [fact({ key: 'a' }), fact({ key: 'b' })] }), 'create');
    const [kept, dropped] = m.facts;
    if (!kept || !dropped) throw new Error('facts missing');
    const now = new Date().toISOString();
    db.raw.prepare("INSERT INTO accuracy_runs (id, trigger, started_at, status) VALUES ('run1', 'manual', ?, 'running')").run(now);
    const addCheck = db.raw.prepare(
      "INSERT INTO fact_checks (id, run_id, fact_id, verdict, method, checked_at, payload) VALUES (?, 'run1', ?, 'verified', 'manual', ?, x'00')",
    );
    addCheck.run('check-kept', kept.id, now);
    addCheck.run('check-dropped', dropped.id, now);
    db.raw
      .prepare(
        "INSERT INTO update_proposals (id, macro_id, run_id, base_version, status, severity, created_at, payload) VALUES ('p1', ?, 'run1', 1, 'pending', 'minor', ?, x'00')",
      )
      .run(m.id, now);
    const ids = (table: string) => (db.raw.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

    repo.replaceFacts(m.id, [fact({ id: kept.id, key: 'a' })]);
    expect(ids('fact_checks')).toEqual(['check-kept']);

    repo.hardDelete(m.id);
    expect(ids('fact_checks')).toEqual([]);
    expect(ids('update_proposals')).toEqual([]);
    expect(ids('accuracy_runs')).toEqual(['run1']);
  });

  it('sorts listAll by title case-insensitively', () => {
    for (const title of ['charlie', 'Bravo', 'alpha', 'Delta']) repo.create(macroInput({ title }), 'create');
    expect(repo.listAll().map((m) => m.title)).toEqual(['alpha', 'Bravo', 'charlie', 'Delta']);
  });

  it('tracks favorite and use count', () => {
    const m = repo.create(macroInput(), 'create');
    expect(repo.setFavorite(m.id, true).isFavorite).toBe(true);
    expect(repo.setFavorite(m.id, false).isFavorite).toBe(false);
    const at = new Date('2026-10-01T10:00:00.000Z');
    repo.recordUse(m.id);
    repo.recordUse(m.id, at);
    expect(repo.get(m.id)).toMatchObject({ useCount: 2, lastUsedAt: at.toISOString() });
  });

  it('replaces facts: in-place updates keep status, new ones are unchecked, removed ones are deleted', () => {
    const m = repo.create(macroInput({ facts: [fact({ key: 'a' }), fact({ key: 'b' }), fact({ key: 'c' })] }), 'create');
    expect(m.facts.map((f) => [f.key, f.status])).toEqual([
      ['a', 'unchecked'],
      ['b', 'unchecked'],
      ['c', 'unchecked'],
    ]);
    const [fa, fb, fc] = m.facts;
    if (!fa || !fb || !fc) throw new Error('facts missing');
    const checkedAt = new Date('2026-10-05T00:00:00.000Z');
    repo.setFactStatus(fa.id, 'verified', checkedAt);

    const next = repo.replaceFacts(m.id, [
      fact({ id: fb.id, key: 'b', statement: 'B changed', sourceUrl: '  ', evidenceQuote: ' quote ' }),
      fact({ key: 'd' }),
      fact({ id: fa.id, key: 'a' }),
      fact({ id: 'foreign-id', key: 'e', status: 'verified' }),
    ]);
    expect(next.map((f) => f.key)).toEqual(['b', 'd', 'a', 'e']);
    expect(next[0]).toMatchObject({ id: fb.id, statement: 'B changed', sourceUrl: null, evidenceQuote: 'quote', status: 'unchecked' });
    expect(next[1]?.status).toBe('unchecked');
    expect(next[1]?.lastCheckedAt).toBeNull();
    expect(next[2]).toMatchObject({ id: fa.id, status: 'verified', lastCheckedAt: checkedAt.toISOString() });
    expect(next[3]?.id).not.toBe('foreign-id');
    expect(next[3]?.status).toBe('verified');

    const stored = repo.get(m.id);
    expect(stored?.facts).toEqual(next);
    expect(stored?.facts.some((f) => f.id === fc.id)).toBe(false);
    expect(stored?.verification).toBe('unverified');
  });

  it('applies an explicit status on in-place fact updates', () => {
    const m = repo.create(macroInput({ facts: [fact()] }), 'create');
    const id = m.facts[0]?.id;
    const [updated] = repo.replaceFacts(m.id, [fact({ id, status: 'outdated' })]);
    expect(updated).toMatchObject({ id, status: 'outdated' });
    expect(updated?.lastCheckedAt).toBeTruthy();
    expect(repo.get(m.id)?.verification).toBe('outdated');
  });

  it('keeps macros.verification in sync with the fact roll-up', () => {
    const m = repo.create(macroInput({ facts: [fact({ key: 'a' }), fact({ key: 'b' })] }), 'create');
    const [a, b] = m.facts;
    if (!a || !b) throw new Error('facts missing');
    repo.setFactStatus(a.id, 'verified');
    expect(repo.get(m.id)?.verification).toBe('unverified');
    repo.setFactStatus(b.id, 'verified');
    expect(repo.get(m.id)?.verification).toBe('verified');
    repo.setFactStatus(b.id, 'outdated');
    expect(repo.get(m.id)?.verification).toBe('outdated');
    repo.setFactStatus(a.id, 'contradicted');
    expect(repo.get(m.id)?.verification).toBe('conflict');
    repo.setFactStatus(a.id, 'unchecked');
    expect(repo.get(m.id)?.facts[0]).toMatchObject({ status: 'unchecked', lastCheckedAt: null });
    expect(repo.get(m.id)?.verification).toBe('outdated');
    expect(() => repo.setFactStatus(a.id, 'bogus' as never)).toThrow('Invalid fact status');
    repo.replaceFacts(m.id, []);
    expect(repo.get(m.id)).toMatchObject({ verification: 'unverified', facts: [] });
    expect(() => repo.setFactStatus('missing', 'verified')).toThrow('Fact not found');
  });

  it('applies facts on update even when content is unchanged', () => {
    const m = repo.create(macroInput(), 'create');
    const updated = repo.update(m.id, macroInput({ facts: [fact({ status: 'verified' })] }), 'manual');
    expect(updated.version).toBe(1);
    expect(updated.facts).toHaveLength(1);
    expect(updated.verification).toBe('verified');
    const untouched = repo.update(m.id, macroInput(), 'manual');
    expect(untouched.facts).toHaveLength(1);
  });

  it('rolls back the whole create when a fact write fails', () => {
    let factWrites = 0;
    const failing = new MacroRepo(db, {
      ...cipher,
      encryptJson: (value, aad) => {
        if (aad.startsWith('facts:') && ++factWrites === 2) throw new Error('boom');
        return cipher.encryptJson(value, aad);
      },
    });
    expect(() => failing.create(macroInput({ facts: [fact(), fact()] }), 'create')).toThrow('boom');
    const count = (table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([count('macros'), count('macro_versions'), count('facts')]).toEqual([0, 0, 0]);
  });

  it('lists 2000 macros with 3 facts each in under a second', () => {
    db.tx(() => {
      for (let i = 0; i < 2000; i++) {
        repo.create(
          macroInput({
            title: `Macro ${i}`,
            body: `Body ${i} `.repeat(40),
            triggers: [`trigger ${i}`, `other ${i}`],
            facts: [fact({ key: `k${i}.1` }), fact({ key: `k${i}.2` }), fact({ key: `k${i}.3` })],
          }),
          'seed',
        );
      }
    });
    const started = performance.now();
    const all = repo.listAll();
    const elapsed = performance.now() - started;
    expect(all).toHaveLength(2000);
    expect(all.every((m) => m.facts.length === 3)).toBe(true);
    expect(all[0]?.title).toBe('Macro 0');
    expect(all[1]?.title).toBe('Macro 1');
    expect(all[1999]?.title).toBe('Macro 1999');
    expect(all[5]?.facts.map((f) => f.key)).toEqual(['k5.1', 'k5.2', 'k5.3']);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('CategoryRepo', () => {
  let repo: CategoryRepo;
  beforeEach(() => {
    repo = new CategoryRepo(db, cipher);
  });

  it('creates, lists sorted by sort then name, updates and deletes', () => {
    const z = repo.create({ name: ' Zeta ', sort: 0 });
    const a = repo.create({ name: 'alpha', color: '#ff0000' });
    const first = repo.create({ name: 'Withdrawals', sort: -1 });
    expect(z).toMatchObject({ name: 'Zeta', color: '#4f7cff', sort: 0 });
    expect(repo.list().map((c) => c.name)).toEqual(['Withdrawals', 'alpha', 'Zeta']);

    const updated = repo.update(a.id, { name: 'Alpha 2' });
    expect(updated).toEqual({ id: a.id, name: 'Alpha 2', color: '#ff0000', sort: 0 });
    expect(repo.update(a.id, { name: 'Alpha 2', sort: 5, color: '#00ff00' })).toMatchObject({ sort: 5, color: '#00ff00' });
    expect(repo.list().map((c) => c.id)).toEqual([first.id, z.id, a.id]);

    repo.delete(z.id);
    expect(repo.list()).toHaveLength(2);
    expect(() => repo.delete(z.id)).toThrow('Category not found');
    expect(() => repo.update('nope', { name: 'x' })).toThrow('Category not found');
  });

  it('validates names and rejects duplicates case-insensitively', () => {
    expect(() => repo.create({ name: '  ' })).toThrow('Name is required');
    const c = repo.create({ name: 'Bonuses' });
    expect(() => repo.create({ name: 'bonuses' })).toThrow('Category name must be unique');
    const other = repo.create({ name: 'KYC' });
    expect(() => repo.update(other.id, { name: 'BONUSES' })).toThrow('Category name must be unique');
    expect(repo.update(c.id, { name: 'BONUSES' }).name).toBe('BONUSES');
  });

  it('ensureByName finds existing categories case-insensitively or creates them', () => {
    const existing = repo.create({ name: 'Sportsbook' });
    expect(repo.ensureByName(' sportsbook ').id).toBe(existing.id);
    const created = repo.ensureByName('Casino');
    expect(created.name).toBe('Casino');
    expect(repo.ensureByName('CASINO').id).toBe(created.id);
    expect(repo.list()).toHaveLength(2);
  });
});

describe('SettingsRepo', () => {
  let repo: SettingsRepo;
  beforeEach(() => {
    repo = new SettingsRepo(db, cipher);
  });

  it('returns defaults when nothing is stored, without sharing references with DEFAULT_SETTINGS', () => {
    const s = repo.get();
    expect(s).toEqual(DEFAULT_SETTINGS);
    s.ai.provider = 'ollama';
    expect(DEFAULT_SETTINGS.ai.provider).toBe('none');
  });

  it('deep-merges patches and persists them', () => {
    const s = repo.update({ ai: { provider: 'anthropic', effort: 'medium' }, ui: { theme: 'dark' } });
    expect(s.ai).toMatchObject({ provider: 'anthropic', effort: 'medium', ollamaModel: DEFAULT_SETTINGS.ai.ollamaModel });
    expect(s.ui.theme).toBe('dark');
    repo.update({ accuracy: { autoApproveMinor: true } });
    const reread = new SettingsRepo(db, cipher).get();
    expect(reread.ai.provider).toBe('anthropic');
    expect(reread.ui.theme).toBe('dark');
    expect(reread.accuracy).toEqual({ ...DEFAULT_SETTINGS.accuracy, autoApproveMinor: true });
  });

  it('merges stored settings over new defaults after upgrades', () => {
    db.raw
      .prepare('INSERT INTO settings (key, payload) VALUES (?, ?)')
      .run('app', cipher.encryptJson({ ai: { provider: 'ollama' }, legacy: { x: 1 } }, 'settings:app'));
    const s = repo.get();
    expect(s.ai.provider).toBe('ollama');
    expect(s.ai.monthlyBudgetUsd).toBe(DEFAULT_SETTINGS.ai.monthlyBudgetUsd);
    expect(s.privacy).toEqual(DEFAULT_SETTINGS.privacy);
    expect(s).not.toHaveProperty('legacy');
  });

  it('validates enums, types and unknown keys', () => {
    const s = repo.update({
      ai: { provider: 'openai' as never, effort: 'max' as never, autoPolish: 'yes' as never, ollamaModel: 42 as never },
      embeddings: { provider: 'transformers' },
      ui: { theme: 'neon' as never },
      unknown: { a: 1 },
      personalization: 'oops',
    } as never);
    expect(s.ai.provider).toBe('none');
    expect(s.ai.effort).toBe('low');
    expect(s.ai.autoPolish).toBe(false);
    expect(s.ai.ollamaModel).toBe(DEFAULT_SETTINGS.ai.ollamaModel);
    expect(s.embeddings.provider).toBe('transformers');
    expect(s.ui.theme).toBe('system');
    expect(s.personalization).toEqual(DEFAULT_SETTINGS.personalization);
    expect(s).not.toHaveProperty('unknown');
  });

  it('trims enum values before validating them', () => {
    const s = repo.update({ ui: { theme: ' dark ' as never }, ai: { provider: 'ollama\n' as never } });
    expect(s.ui.theme).toBe('dark');
    expect(s.ai.provider).toBe('ollama');
  });

  it('clamps numbers and trims/caps strings', () => {
    let s = repo.update({
      recommendation: { minConfidence: 150, maxResults: 7 },
      accuracy: { intervalHours: 1 },
      ai: { monthlyBudgetUsd: -5, ollamaUrl: '  http://localhost:11434  ', anthropicModel: '   ' },
      privacy: { analyticsRetentionDays: 99999 },
      personalization: { greeting: `Hello ${'x'.repeat(600)}`, userFallback: '  ' },
    });
    expect(s.recommendation).toEqual({ minConfidence: 100, maxResults: 3 });
    expect(s.accuracy.intervalHours).toBe(6);
    expect(s.ai.monthlyBudgetUsd).toBe(0);
    expect(s.ai.ollamaUrl).toBe('http://localhost:11434');
    expect(s.ai.anthropicModel).toBe(DEFAULT_SETTINGS.ai.anthropicModel);
    expect(s.privacy.analyticsRetentionDays).toBe(3650);
    expect(s.personalization.greeting).toHaveLength(500);
    expect(s.personalization.userFallback).toBe('');

    s = repo.update({
      recommendation: { minConfidence: -1, maxResults: 1.6 },
      accuracy: { intervalHours: 10_000 },
      ai: { monthlyBudgetUsd: 5000 },
      privacy: { analyticsRetentionDays: 0 },
    });
    expect(s.recommendation).toEqual({ minConfidence: 0, maxResults: 2 });
    expect(s.accuracy.intervalHours).toBe(720);
    expect(s.ai.monthlyBudgetUsd).toBe(1000);
    expect(s.privacy.analyticsRetentionDays).toBe(1);
    expect(repo.update({ recommendation: { minConfidence: Number.NaN } }).recommendation.minConfidence).toBe(0);
  });

  it('stores secrets separately and derives anthropicKeySet', () => {
    expect(repo.getSecret('anthropic_api_key')).toBeNull();
    expect(repo.update({ ai: { anthropicKeySet: true } }).ai.anthropicKeySet).toBe(false);
    repo.setSecret('anthropic_api_key', 'sk-ant-test-123');
    expect(repo.getSecret('anthropic_api_key')).toBe('sk-ant-test-123');
    expect(repo.get().ai.anthropicKeySet).toBe(true);
    expect(repo.update({ ai: { anthropicKeySet: false } }).ai.anthropicKeySet).toBe(true);
    repo.setSecret('anthropic_api_key', null);
    expect(repo.getSecret('anthropic_api_key')).toBeNull();
    expect(repo.get().ai.anthropicKeySet).toBe(false);
    const raw = db.raw.prepare("SELECT key FROM settings WHERE key LIKE 'secret:%'").all();
    expect(raw).toEqual([]);
  });
});

describe('EventRepo', () => {
  it('adds, lists with filters and purges old events', () => {
    const repo = new EventRepo(db, cipher);
    const now = new Date('2026-10-08T12:00:00.000Z');
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    repo.add({ type: 'recommendation_shown', macroIds: ['m1', 'm2'], confidence: 80, intents: ['general'] }, daysAgo(100));
    repo.add({ type: 'reply_copied', macroIds: ['m1'], editRatio: 0.1, mode: 'fast' }, daysAgo(10));
    repo.add({ type: 'recommendation_selected', rank: 0, message: 'customer secret text' } as never, daysAgo(1));

    const all = repo.list();
    expect(all.map((e) => e.type)).toEqual(['recommendation_shown', 'reply_copied', 'recommendation_selected']);
    expect(all[1]).toMatchObject({ type: 'reply_copied', macroIds: ['m1'], editRatio: 0.1, mode: 'fast', ts: daysAgo(10).toISOString() });
    expect(all[1]?.uid).toBeTruthy();
    expect(all[2]).not.toHaveProperty('message');
    expect(repo.list({ since: daysAgo(30) }).map((e) => e.type)).toEqual(['reply_copied', 'recommendation_selected']);
    expect(repo.list({ type: 'reply_copied' })).toHaveLength(1);
    expect(repo.list({ since: daysAgo(5), type: 'reply_copied' })).toHaveLength(0);
    expect(() => repo.add({ type: 'bogus' as never })).toThrow('Unknown event type');

    expect(repo.purgeOlderThan(90, now)).toBe(1);
    expect(repo.purgeOlderThan(90, now)).toBe(0);
    expect(repo.list()).toHaveLength(2);
    expect(() => repo.purgeOlderThan(Number.NaN, now)).toThrow(/Retention days/);
    expect(() => repo.purgeOlderThan(-1, now)).toThrow(/Retention days/);
  });

  it('keeps insertion order for events with the same timestamp', () => {
    const repo = new EventRepo(db, cipher);
    const at = new Date('2026-10-08T12:00:00.000Z');
    for (let rank = 0; rank < 25; rank++) repo.add({ type: 'recommendation_selected', rank }, at);
    expect(repo.list().map((e) => e.rank)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
});

describe('LlmUsageRepo', () => {
  it('sums usage per UTC calendar month', () => {
    const repo = new LlmUsageRepo(db);
    repo.record('personalize', usage(0.001), new Date('2026-10-01T00:00:00.000Z'));
    repo.record('draft', usage(0.002, 200, 80), new Date('2026-10-31T23:59:59.000Z'));
    repo.record('personalize', usage(0.5), new Date('2026-09-30T23:59:59.000Z'));
    expect(repo.monthTotals('2026-10')).toEqual({ requests: 2, inputTokens: 300, outputTokens: 130, costUsd: expect.closeTo(0.003, 9) });
    expect(repo.monthTotals('2026-09').requests).toBe(1);
    expect(repo.monthTotals('2020-01')).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    repo.record('personalize', usage(0.01));
    expect(repo.monthTotals().requests).toBeGreaterThanOrEqual(1);
  });
});

describe('EmbeddingRepo', () => {
  it('round-trips vectors (including subarray views) and returns fresh arrays', () => {
    const repo = new EmbeddingRepo(db, cipher);
    const backing = new Float32Array([9, 9, 0.25, -1.5, 3.75, 9]);
    const view = backing.subarray(2, 5);
    repo.set('builtin-v1', 'h1', view);
    const out = repo.get('builtin-v1', 'h1');
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out ?? [])).toEqual([0.25, -1.5, 3.75]);
    expect(out?.byteOffset).toBe(0);
    expect(out?.buffer).not.toBe(backing.buffer);
    const dim = db.raw.prepare('SELECT dim FROM embeddings WHERE model = ? AND content_hmac = ?').get('builtin-v1', 'h1') as { dim: number };
    expect(dim.dim).toBe(3);
    expect(repo.get('builtin-v1', 'missing')).toBeNull();
    expect(repo.get('other-model', 'h1')).toBeNull();

    repo.set('builtin-v1', 'h1', new Float32Array([1, 2]));
    expect(Array.from(repo.get('builtin-v1', 'h1') ?? [])).toEqual([1, 2]);
  });

  it('prunes vectors not in the keep set for one model only', () => {
    const repo = new EmbeddingRepo(db, cipher);
    for (const h of ['a', 'b', 'c']) repo.set('m1', h, new Float32Array([1]));
    repo.set('m2', 'a', new Float32Array([1]));
    expect(repo.prune('m1', new Set(['b']))).toBe(2);
    expect(repo.get('m1', 'a')).toBeNull();
    expect(repo.get('m1', 'b')).not.toBeNull();
    expect(repo.get('m2', 'a')).not.toBeNull();
    expect(repo.prune('m1', new Set(['b']))).toBe(0);
  });
});

describe('encryption at rest', () => {
  const MARKERS = {
    title: 'ZEBRA-TITLE-4417',
    body: 'QUOKKA-BODY-9921',
    tag: 'NARWHAL-TAG-3301',
    trigger: 'OCELOT-TRIGGER-5150',
    notes: 'PANGOLIN-NOTES-8812',
    shortcut: 'AXOLOTL-SC-2290',
    changeNote: 'MARMOT-NOTE-6634',
    factKey: 'IBEX-FACTKEY-1203',
    factStatement: 'TAPIR-STATEMENT-7745',
    factValue: 'LEMUR-VALUE-0042',
    factUrl: 'https://example.invalid/OKAPI-URL-5518',
    evidence: 'GECKO-EVIDENCE-3376',
    category: 'BISON-CATEGORY-9087',
    greeting: 'WOMBAT-GREETING-1166',
    secret: 'sk-ant-MANATEE-SECRET-4480',
  };
  const VECTOR = new Float32Array([0.123456, -7.654321, 42.4242, 1e-7]);

  function populate(target: Db, c: Cipher): { macroId: string; contentKey: string } {
    const categories = new CategoryRepo(target, c);
    const category = categories.create({ name: MARKERS.category });
    const macros = new MacroRepo(target, c);
    const macro = macros.create(
      macroInput({
        title: MARKERS.title,
        body: MARKERS.body,
        categoryId: category.id,
        tags: [MARKERS.tag],
        triggers: [MARKERS.trigger],
        notes: MARKERS.notes,
        shortcut: MARKERS.shortcut,
        changeNote: MARKERS.changeNote,
        facts: [
          {
            key: MARKERS.factKey,
            statement: MARKERS.factStatement,
            value: MARKERS.factValue,
            sourceUrl: MARKERS.factUrl,
            evidenceQuote: MARKERS.evidence,
          },
        ],
      }),
      'create',
    );
    const settings = new SettingsRepo(target, c);
    settings.update({ personalization: { greeting: MARKERS.greeting } });
    settings.setSecret('anthropic_api_key', MARKERS.secret);
    new EventRepo(target, c).add({ type: 'reply_copied', macroIds: [macro.id] });
    const contentKey = macros.contentKey(macro.id) ?? '';
    new EmbeddingRepo(target, c).set('builtin-v1', contentKey, VECTOR);
    return { macroId: macro.id, contentKey };
  }

  function assertNoPlaintext(haystack: Buffer, where: string): void {
    for (const [name, marker] of Object.entries(MARKERS)) {
      expect(haystack.includes(Buffer.from(marker, 'utf8')), `${name} leaked in ${where}`).toBe(false);
    }
    expect(haystack.includes(Buffer.from(VECTOR.buffer)), `vector leaked in ${where}`).toBe(false);
  }

  const PAYLOAD_TABLES = ['categories', 'macros', 'macro_versions', 'facts', 'settings', 'embeddings', 'events', 'meta'];

  it('stores no plaintext content in any table', () => {
    populate(db, cipher);
    for (const table of PAYLOAD_TABLES) {
      const rows = db.raw.prepare(`SELECT * FROM ${table}`).all();
      expect(rows.length, `${table} should have rows`).toBeGreaterThan(0);
      const bytes = Buffer.concat(
        rows.flatMap((row) =>
          Object.values(row).map((v) => (v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v), 'utf8'))),
        ),
      );
      assertNoPlaintext(bytes, table);
    }
  });

  it('leaves no plaintext in the database files on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'macropilot-repos-'));
    try {
      const file = join(dir, 'data.db');
      const fileDb = openDatabase(file);
      populate(fileDb, cipher);
      const wal = `${file}-wal`;
      const walBytes = existsSync(wal) ? readFileSync(wal) : Buffer.alloc(0);
      assertNoPlaintext(Buffer.concat([readFileSync(file), walBytes]), 'db files');
      fileDb.close();
      assertNoPlaintext(readFileSync(file), 'db file after checkpoint');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails to read rows with the wrong key or with a payload moved to another row', () => {
    const { macroId, contentKey } = populate(db, cipher);
    const other = new MacroRepo(db, cipher).create(macroInput({ title: 'Other', facts: [fact()] }), 'create');
    const wrongKey = createCipher(randomBytes(32));
    expect(() => new MacroRepo(db, wrongKey).listAll()).toThrow(DecryptionError);
    expect(() => new CategoryRepo(db, wrongKey).list()).toThrow(DecryptionError);
    expect(() => new SettingsRepo(db, wrongKey).get()).toThrow(DecryptionError);
    expect(() => new SettingsRepo(db, wrongKey).getSecret('anthropic_api_key')).toThrow(DecryptionError);
    expect(() => new EventRepo(db, wrongKey).list()).toThrow(DecryptionError);
    expect(() => new EmbeddingRepo(db, wrongKey).get('builtin-v1', contentKey)).toThrow(DecryptionError);

    // A fact payload moved to another fact row must not decrypt either.
    db.raw.prepare('UPDATE facts SET payload = (SELECT payload FROM facts WHERE macro_id = ?) WHERE macro_id = ?').run(other.id, macroId);
    expect(() => new MacroRepo(db, cipher).listAll()).toThrow(DecryptionError);
    db.raw.prepare('DELETE FROM facts WHERE macro_id = ?').run(macroId);

    // Copy the other macro's version payload into this macro's row: AAD binding must reject it.
    db.raw
      .prepare('UPDATE macro_versions SET payload = (SELECT payload FROM macro_versions WHERE macro_id = ?) WHERE macro_id = ?')
      .run(other.id, macroId);
    expect(() => new MacroRepo(db, cipher).get(macroId)).toThrow(DecryptionError);
    expect(new MacroRepo(db, cipher).get(other.id)?.title).toBe('Other');

    // Swap the secret into the app settings slot.
    db.raw
      .prepare("UPDATE settings SET payload = (SELECT payload FROM settings WHERE key = 'secret:anthropic_api_key') WHERE key = 'app'")
      .run();
    expect(() => new SettingsRepo(db, cipher).get()).toThrow(DecryptionError);
  });
});
