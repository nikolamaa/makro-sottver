/**
 * Master key storage. The 256-bit master key (DEK) never lives next to the database.
 *
 * Order of preference:
 *   1. env  - MACROPILOT_MASTER_KEY (base64, 32 bytes). Only for tests/CI/headless use.
 *   2. keychain - OS credential store via optional dependency @napi-rs/keyring
 *                 (Windows Credential Manager / macOS Keychain / Linux Secret Service).
 *   3. file - <keyDir>/master.key (base64), created with mode 0o600, keyDir created with 0o700.
 *             keyDir is a different directory than the data dir (see config.ts).
 *
 * Safety rules (losing the key makes the encrypted database unreadable):
 *   - An existing but malformed key (file or keychain) is reported with a clear Error and never overwritten.
 *   - A keychain that is missing, broken or slow never crashes startup: every call is time-boxed and any
 *     failure falls back to the key file.
 *   - When a key is stored in the keychain, a marker file (<keyDir>/master.key.in-keychain) records that.
 *     If the keychain later cannot produce the key, loading throws instead of silently creating a new key
 *     that could never decrypt the existing data.
 */
import { randomBytes } from 'node:crypto';
import { access, link, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type KeyStorage = 'keychain' | 'file' | 'env';

/** Minimal credential-store interface: the OS keychain by default, injectable for tests. */
export interface KeychainBackend {
  /** The stored value, or null/undefined when there is no entry. Rejects when the store is unavailable. */
  get(service: string, account: string, signal: AbortSignal): Promise<string | null | undefined>;
  set(service: string, account: string, value: string, signal: AbortSignal): Promise<void>;
  /** Resolves true when an entry was removed and false when there was none. */
  delete(service: string, account: string, signal: AbortSignal): Promise<boolean>;
}

export interface KeyStoreOptions {
  /** Directory for the fallback key file (separate from the data directory). */
  keyDir: string;
  /** Keychain service name, default "MacroPilot". */
  service?: string;
  /** Keychain account name, default "master-key". */
  account?: string;
  /** Skip the OS keychain (tests, or when the user opts out). */
  disableKeychain?: boolean;
  /**
   * Base64 key from the environment; when set it always wins and nothing is persisted.
   * An empty or whitespace-only value counts as unset; anything else must decode to exactly 32 bytes.
   */
  envKey?: string;
  /** Upper bound for a single keychain call before the keychain is treated as unavailable (default 3000 ms). */
  keychainTimeoutMs?: number;
  /** Credential store to use instead of the OS keychain (tests). Ignored when disableKeychain is set. */
  keychain?: KeychainBackend;
}

export interface MasterKeyResult {
  key: Buffer;
  storage: KeyStorage;
  /** True when a new key was generated during this call. */
  created: boolean;
}

const KEY_LEN = 32;
const KEY_FILE = 'master.key';
const KEYCHAIN_MARKER_FILE = 'master.key.in-keychain';
const KEYCHAIN_MARKER_TEXT =
  'The MacroPilot master key is stored in the OS keychain. While this file exists MacroPilot will not create\n' +
  'a new key when the keychain is unavailable (that would make the encrypted data unreadable). Do not delete it.\n';
const DEFAULT_SERVICE = 'MacroPilot';
const DEFAULT_ACCOUNT = 'master-key';
const DEFAULT_KEYCHAIN_TIMEOUT_MS = 3000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

// ---------------------------------------------------------------------------
// OS keychain backend (@napi-rs/keyring, optional dependency)
// ---------------------------------------------------------------------------

/** Non-literal specifier: the package is optional, so its absence must not break type checking or bundling. */
const KEYRING_MODULE: string = '@napi-rs/keyring';

/**
 * On Linux, pin the entry to the Secret Service. The library's default silently falls back to the kernel
 * keyring, which is cleared on logout/reboot - the only copy of the master key must never live there.
 * The option is ignored on Windows and macOS.
 */
const ENTRY_OPTIONS = { linux: { store: 'secret-service' } } as const;

interface NapiAsyncEntry {
  getPassword(signal?: AbortSignal): Promise<string | null | undefined>;
  setPassword(password: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}
type NapiAsyncEntryClass = new (service: string, account: string, options?: typeof ENTRY_OPTIONS) => NapiAsyncEntry;

let asyncEntryClass: Promise<NapiAsyncEntryClass> | undefined;

/** Lazily import the native module once; a missing or broken module yields a (cached) rejection. */
function loadAsyncEntryClass(): Promise<NapiAsyncEntryClass> {
  asyncEntryClass ??= import(KEYRING_MODULE).then((mod: { AsyncEntry?: unknown }) => {
    if (typeof mod.AsyncEntry !== 'function') throw new Error('@napi-rs/keyring has no AsyncEntry export');
    return mod.AsyncEntry as NapiAsyncEntryClass;
  });
  return asyncEntryClass;
}

/** The constructor throws synchronously when the store is unreachable (e.g. no D-Bus session on Linux). */
async function openEntry(service: string, account: string): Promise<NapiAsyncEntry> {
  const AsyncEntry = await loadAsyncEntryClass();
  return new AsyncEntry(service, account, ENTRY_OPTIONS);
}

const osKeychain: KeychainBackend = {
  get: async (service, account, signal) => (await openEntry(service, account)).getPassword(signal),
  set: async (service, account, value, signal) => (await openEntry(service, account)).setPassword(value, signal),
  delete: async (service, account, signal) => (await openEntry(service, account)).deleteCredential(signal),
};

/** Run `op` but give up after `ms` (aborting it) so a stuck credential store can never hang startup. */
async function withTimeout<T>(ms: number, op: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Keychain did not respond in time'));
    }, ms);
  });
  try {
    return await Promise.race([op(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** One keychain entry (service + account) with every call time-boxed. */
interface KeychainSlot {
  get(): Promise<string | null | undefined>;
  set(value: string): Promise<void>;
  delete(): Promise<boolean>;
}

function keychainSlot(backend: KeychainBackend, service: string, account: string, timeoutMs: number): KeychainSlot {
  return {
    get: () => withTimeout(timeoutMs, (signal) => backend.get(service, account, signal)),
    set: (value) => withTimeout(timeoutMs, (signal) => backend.set(service, account, value, signal)),
    delete: () => withTimeout(timeoutMs, (signal) => backend.delete(service, account, signal)),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface KeyStoreContext {
  keyDir: string;
  keyFile: string;
  markerFile: string;
  service: string;
  account: string;
  /** null when the keychain is disabled. */
  keychain: KeychainSlot | null;
}

type KeychainLookup = { kind: 'found'; value: string } | { kind: 'absent' | 'unavailable' | 'disabled' };

function resolveContext(opts: KeyStoreOptions): KeyStoreContext {
  const service = opts.service ?? DEFAULT_SERVICE;
  const account = opts.account ?? DEFAULT_ACCOUNT;
  const timeoutMs = opts.keychainTimeoutMs ?? DEFAULT_KEYCHAIN_TIMEOUT_MS;
  return {
    keyDir: opts.keyDir,
    keyFile: join(opts.keyDir, KEY_FILE),
    markerFile: join(opts.keyDir, KEYCHAIN_MARKER_FILE),
    service,
    account,
    keychain: opts.disableKeychain ? null : keychainSlot(opts.keychain ?? osKeychain, service, account, timeoutMs),
  };
}

function isErrnoException(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

function encodeKey(key: Buffer): string {
  return key.toString('base64');
}

/** Strict base64 -> 32-byte key; null when the text is not a valid key. */
function decodeKey(text: string): Buffer | null {
  const trimmed = text.trim();
  if (!BASE64_RE.test(trimmed)) return null;
  const key = Buffer.from(trimmed, 'base64');
  return key.length === KEY_LEN ? key : null;
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LEN) throw new Error('Master key must be 32 bytes');
}

/** The env key, or null when unset/blank. Throws when it is set but not a 32-byte base64 key. */
function readEnvKey(opts: KeyStoreOptions): Buffer | null {
  if (!opts.envKey?.trim()) return null;
  const key = decodeKey(opts.envKey);
  if (!key) throw new Error('MACROPILOT_MASTER_KEY must be the base64 encoding of exactly 32 bytes');
  return key;
}

function malformedKeyError(where: string): Error {
  return new Error(
    `The master key in ${where} is malformed (expected base64 of 32 bytes). It was left unchanged so the ` +
      'encrypted data stays recoverable; restore the original key or use your recovery key.',
  );
}

const KEYCHAIN_PROBLEMS: Record<Exclude<KeychainLookup['kind'], 'found'>, string> = {
  absent: 'the keychain entry no longer exists',
  unavailable: 'the keychain is locked or did not respond',
  disabled: 'keychain access is disabled',
};

function keychainKeyUnreadableError(ctx: KeyStoreContext, problem: Exclude<KeychainLookup['kind'], 'found'>): Error {
  return new Error(
    `MacroPilot's master key is kept in the OS keychain (service "${ctx.service}", account "${ctx.account}"), ` +
      `but ${KEYCHAIN_PROBLEMS[problem]}. No new key was created, so the encrypted data is untouched. Unlock or ` +
      're-enable the keychain and restart MacroPilot, or restore the key with your recovery key.',
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (isErrnoException(err, 'ENOENT')) return false;
    throw err;
  }
}

async function ensureKeyDir(keyDir: string): Promise<void> {
  await mkdir(keyDir, { recursive: true, mode: DIR_MODE });
}

/** Write a new file (must not exist) with owner-only permissions and flush it to disk. */
async function writeNewFileDurably(path: string, data: string): Promise<void> {
  const handle = await open(path, 'wx', FILE_MODE);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Best effort: make a rename/link inside `dir` survive a power loss (not supported on Windows). */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Durability hint only; the key file itself is already flushed.
  }
}

/**
 * Move `tmp` to `target` unless `target` already exists (another process created a key first).
 * A hard link is atomic and fails with EEXIST; filesystems without hard links fall back to check + rename.
 */
async function publishWithoutClobber(tmp: string, target: string): Promise<boolean> {
  try {
    await link(tmp, target);
    return true;
  } catch (err) {
    if (isErrnoException(err, 'EEXIST')) return false;
  }
  if (await pathExists(target)) return false;
  await rename(tmp, target);
  return true;
}

// ---------------------------------------------------------------------------
// Key file and keychain operations
// ---------------------------------------------------------------------------

/** The key from <keyDir>/master.key; null when the file does not exist; throws when unreadable/malformed. */
async function readKeyFile(ctx: KeyStoreContext): Promise<Buffer | null> {
  let text: string;
  try {
    text = await readFile(ctx.keyFile, 'utf8');
  } catch (err) {
    if (isErrnoException(err, 'ENOENT')) return null;
    throw new Error(`Cannot read the master key file ${ctx.keyFile}`, { cause: err });
  }
  const key = decodeKey(text);
  if (!key) throw malformedKeyError(ctx.keyFile);
  return key;
}

/**
 * Atomically write the key file (tmp file + rename). With overwrite=false an existing file wins and its key is
 * returned instead; otherwise the written key is returned.
 */
async function writeKeyFile(ctx: KeyStoreContext, key: Buffer, overwrite: boolean): Promise<Buffer> {
  await ensureKeyDir(ctx.keyDir);
  const tmp = `${ctx.keyFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeNewFileDurably(tmp, `${encodeKey(key)}\n`);
    if (overwrite) {
      await rename(tmp, ctx.keyFile);
    } else if (!(await publishWithoutClobber(tmp, ctx.keyFile))) {
      const existing = await readKeyFile(ctx);
      if (existing) return existing;
      throw new Error(`The master key file ${ctx.keyFile} disappeared while it was being created`);
    }
  } finally {
    await rm(tmp, { force: true });
  }
  await syncDir(ctx.keyDir);
  return key;
}

async function readKeychain(ctx: KeyStoreContext): Promise<KeychainLookup> {
  if (!ctx.keychain) return { kind: 'disabled' };
  try {
    const value = await ctx.keychain.get();
    return value == null ? { kind: 'absent' } : { kind: 'found', value };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * Store the key in the keychain and read it back (some stores accept writes they do not keep). On success the
 * marker file is written and the key now held by the keychain is returned; any failure returns null.
 */
async function storeInKeychain(ctx: KeyStoreContext, key: Buffer): Promise<Buffer | null> {
  if (!ctx.keychain) return null;
  try {
    await ctx.keychain.set(encodeKey(key));
    const stored = decodeKey((await ctx.keychain.get()) ?? '');
    if (!stored) return null;
    await ensureKeyDir(ctx.keyDir);
    await writeFile(ctx.markerFile, KEYCHAIN_MARKER_TEXT, { mode: FILE_MODE });
    return stored;
  } catch {
    return null;
  }
}

/** Generate a key and persist it, preferring the keychain when it answered the lookup. */
async function createMasterKey(ctx: KeyStoreContext, keychainReachable: boolean): Promise<MasterKeyResult> {
  const key = randomBytes(KEY_LEN);
  const inKeychain = keychainReachable ? await storeInKeychain(ctx, key) : null;
  if (inKeychain) return { key: inKeychain, storage: 'keychain', created: inKeychain.equals(key) };
  const inFile = await writeKeyFile(ctx, key, false);
  return { key: inFile, storage: 'file', created: inFile.equals(key) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the master key, or generate + persist a new random one if none exists.
 * Precedence: env -> keychain -> file -> create (keychain preferred, else file).
 * Throws (and changes nothing) when a stored key is malformed or unreadable, or when the key is known to live
 * in the keychain but the keychain cannot produce it.
 */
export async function loadOrCreateMasterKey(opts: KeyStoreOptions): Promise<MasterKeyResult> {
  const envKey = readEnvKey(opts);
  if (envKey) return { key: envKey, storage: 'env', created: false };

  const ctx = resolveContext(opts);
  const lookup = await readKeychain(ctx);
  if (lookup.kind === 'found') {
    const key = decodeKey(lookup.value);
    if (!key) throw malformedKeyError(`the OS keychain (service "${ctx.service}", account "${ctx.account}")`);
    return { key, storage: 'keychain', created: false };
  }

  const fileKey = await readKeyFile(ctx);
  if (fileKey) return { key: fileKey, storage: 'file', created: false };

  if (await pathExists(ctx.markerFile)) throw keychainKeyUnreadableError(ctx, lookup.kind);
  return createMasterKey(ctx, lookup.kind === 'absent');
}

/**
 * Persist a given key (used when restoring with a recovery key). Returns where it was stored.
 * Replaces any previously stored key: keychain preferred (a stale key file is then removed), else the key file
 * (a stale keychain entry is then removed best-effort so it cannot shadow the file). With an env key nothing
 * is persisted: returns 'env' when the keys match and throws when they differ.
 */
export async function storeMasterKey(key: Buffer, opts: KeyStoreOptions): Promise<KeyStorage> {
  assertKeyLength(key);
  const envKey = readEnvKey(opts);
  if (envKey) {
    if (!envKey.equals(key)) throw new Error('MACROPILOT_MASTER_KEY is set to a different key; unset it to store a new master key');
    return 'env';
  }

  const ctx = resolveContext(opts);
  const inKeychain = await storeInKeychain(ctx, key);
  if (inKeychain?.equals(key)) {
    await rm(ctx.keyFile, { force: true });
    return 'keychain';
  }

  await writeKeyFile(ctx, key, true);
  await ctx.keychain?.delete().catch(() => false);
  await rm(ctx.markerFile, { force: true });
  return 'file';
}

/**
 * Remove the stored key from keychain and file (used by tests and "reset app"). Missing entries are ignored,
 * as is an unreachable keychain unless the marker says the key lives there (then it throws, keeping the marker).
 */
export async function deleteMasterKey(opts: KeyStoreOptions): Promise<void> {
  const ctx = resolveContext(opts);
  await rm(ctx.keyFile, { force: true });
  if (ctx.keychain) {
    try {
      await ctx.keychain.delete();
    } catch (err) {
      if (await pathExists(ctx.markerFile)) {
        throw new Error('Could not remove the master key from the OS keychain (locked or not responding)', { cause: err });
      }
    }
  }
  await rm(ctx.markerFile, { force: true });
}
