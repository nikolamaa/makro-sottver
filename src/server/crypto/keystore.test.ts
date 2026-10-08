import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteMasterKey,
  loadOrCreateMasterKey,
  storeMasterKey,
  type KeychainBackend,
  type KeyStoreOptions,
} from './keystore.js';

const isWindows = process.platform === 'win32';
const KEY_FILE = 'master.key';
const MARKER_FILE = 'master.key.in-keychain';

type FakeMode = 'ok' | 'unavailable' | 'hang' | 'forgetful';

/** In-memory credential store that can simulate an unavailable, hanging or write-dropping keychain. */
class FakeKeychain implements KeychainBackend {
  readonly entries = new Map<string, string>();
  mode: FakeMode = 'ok';
  abortedCalls = 0;

  get(service: string, account: string, signal: AbortSignal): Promise<string | null | undefined> {
    return this.run(signal, () => (this.mode === 'forgetful' ? undefined : this.entries.get(this.id(service, account))));
  }

  set(service: string, account: string, value: string, signal: AbortSignal): Promise<void> {
    return this.run(signal, () => {
      this.entries.set(this.id(service, account), value);
    });
  }

  delete(service: string, account: string, signal: AbortSignal): Promise<boolean> {
    return this.run(signal, () => this.entries.delete(this.id(service, account)));
  }

  private id(service: string, account: string): string {
    return `${service}/${account}`;
  }

  private run<T>(signal: AbortSignal, op: () => T): Promise<T> {
    if (this.mode === 'unavailable') return Promise.reject(new Error('Platform failure: no secret service'));
    if (this.mode === 'hang') {
      return new Promise<T>((_, reject) => {
        signal.addEventListener('abort', () => {
          this.abortedCalls++;
          reject(new Error('aborted'));
        });
      });
    }
    return Promise.resolve(op());
  }
}

const DEFAULT_ENTRY = 'MacroPilot/master-key';

let keyDir: string;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'macropilot-keystore-'));
  keyDir = join(root, 'nested', 'keys');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fileOpts(extra: Partial<KeyStoreOptions> = {}): KeyStoreOptions {
  return { keyDir, disableKeychain: true, ...extra };
}

function keychainOpts(keychain: FakeKeychain, extra: Partial<KeyStoreOptions> = {}): KeyStoreOptions {
  return { keyDir, keychain, keychainTimeoutMs: 200, ...extra };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function readKeyFile(): Promise<string> {
  return readFile(join(keyDir, KEY_FILE), 'utf8');
}

describe('env key', () => {
  it('wins over everything and persists nothing', async () => {
    const key = randomBytes(32);
    const keychain = new FakeKeychain();
    keychain.entries.set(DEFAULT_ENTRY, randomBytes(32).toString('base64'));

    const res = await loadOrCreateMasterKey(keychainOpts(keychain, { envKey: key.toString('base64') }));

    expect(res).toEqual({ key, storage: 'env', created: false });
    expect(await listDir(keyDir)).toEqual([]);
  });

  it('treats a blank value as unset', async () => {
    const res = await loadOrCreateMasterKey(fileOpts({ envKey: '   ' }));
    expect(res.storage).toBe('file');
    expect(res.created).toBe(true);
  });

  it.each([
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(33).toString('base64')],
    ['not base64', 'this is not a key!'],
  ])('rejects a key that is %s', async (_label, envKey) => {
    await expect(loadOrCreateMasterKey(fileOpts({ envKey }))).rejects.toThrow(/exactly 32 bytes/);
    expect(await listDir(keyDir)).toEqual([]);
  });
});

describe('key file (keychain disabled)', () => {
  it('creates a key once and loads the same key afterwards', async () => {
    const first = await loadOrCreateMasterKey(fileOpts());
    expect(first.storage).toBe('file');
    expect(first.created).toBe(true);
    expect(first.key).toHaveLength(32);
    expect((await readKeyFile()).trim()).toBe(first.key.toString('base64'));

    const second = await loadOrCreateMasterKey(fileOpts());
    expect(second).toEqual({ key: first.key, storage: 'file', created: false });
    expect(await listDir(keyDir)).toEqual([KEY_FILE]); // no temp files left behind
  });

  it.skipIf(isWindows)('restricts permissions to the owner (dir 0700, file 0600)', async () => {
    await loadOrCreateMasterKey(fileOpts());
    expect((await stat(keyDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(keyDir, KEY_FILE))).mode & 0o777).toBe(0o600);
  });

  it('two concurrent first starts agree on one key', async () => {
    const [a, b] = await Promise.all([loadOrCreateMasterKey(fileOpts()), loadOrCreateMasterKey(fileOpts())]);
    expect(a.key.equals(b.key)).toBe(true);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await listDir(keyDir)).toEqual([KEY_FILE]);
  });

  it.each([
    ['garbage', 'not-a-key at all'],
    ['a 16-byte key', randomBytes(16).toString('base64')],
    ['an empty file', ''],
  ])('refuses to load %s and never overwrites it', async (_label, content) => {
    await mkdir(keyDir, { recursive: true });
    await writeFile(join(keyDir, KEY_FILE), content);

    await expect(loadOrCreateMasterKey(fileOpts())).rejects.toThrow(/malformed/);
    await expect(loadOrCreateMasterKey(fileOpts())).rejects.toThrow(/malformed/);
    expect(await readKeyFile()).toBe(content);
    expect(await listDir(keyDir)).toEqual([KEY_FILE]);
  });

  it('an explicit restore (storeMasterKey) may replace a malformed key file', async () => {
    await mkdir(keyDir, { recursive: true });
    await writeFile(join(keyDir, KEY_FILE), 'corrupted');
    const key = randomBytes(32);
    expect(await storeMasterKey(key, fileOpts())).toBe('file');
    expect(await loadOrCreateMasterKey(fileOpts())).toEqual({ key, storage: 'file', created: false });
  });

  it('error messages never contain the key material', async () => {
    const secret = randomBytes(31).toString('base64');
    await mkdir(keyDir, { recursive: true });
    await writeFile(join(keyDir, KEY_FILE), secret);
    await expect(loadOrCreateMasterKey(fileOpts())).rejects.toSatisfy((err: Error) => !err.message.includes(secret));
  });

  it('accepts a key file with surrounding whitespace', async () => {
    const key = randomBytes(32);
    await mkdir(keyDir, { recursive: true });
    await writeFile(join(keyDir, KEY_FILE), `\n  ${key.toString('base64')}\r\n`);
    expect(await loadOrCreateMasterKey(fileOpts())).toEqual({ key, storage: 'file', created: false });
  });
});

describe('keychain', () => {
  it('is preferred for a new key; no key file is written', async () => {
    const keychain = new FakeKeychain();
    const first = await loadOrCreateMasterKey(keychainOpts(keychain));

    expect(first.storage).toBe('keychain');
    expect(first.created).toBe(true);
    expect(keychain.entries.get(DEFAULT_ENTRY)).toBe(first.key.toString('base64'));
    expect(await listDir(keyDir)).toEqual([MARKER_FILE]);

    const second = await loadOrCreateMasterKey(keychainOpts(keychain));
    expect(second).toEqual({ key: first.key, storage: 'keychain', created: false });
  });

  it('honours custom service and account names', async () => {
    const keychain = new FakeKeychain();
    const res = await loadOrCreateMasterKey(keychainOpts(keychain, { service: 'Svc', account: 'acct' }));
    expect(keychain.entries.get('Svc/acct')).toBe(res.key.toString('base64'));
  });

  it('takes precedence over an existing key file', async () => {
    const keychain = new FakeKeychain();
    const keychainKey = randomBytes(32);
    keychain.entries.set(DEFAULT_ENTRY, keychainKey.toString('base64'));
    await mkdir(keyDir, { recursive: true });
    await writeFile(join(keyDir, KEY_FILE), randomBytes(32).toString('base64'));

    expect(await loadOrCreateMasterKey(keychainOpts(keychain))).toEqual({ key: keychainKey, storage: 'keychain', created: false });
  });

  it('falls back to the key file when the keychain is unavailable', async () => {
    const keychain = new FakeKeychain();
    keychain.mode = 'unavailable';
    const first = await loadOrCreateMasterKey(keychainOpts(keychain));
    expect(first.storage).toBe('file');
    expect(first.created).toBe(true);

    const second = await loadOrCreateMasterKey(keychainOpts(keychain));
    expect(second).toEqual({ key: first.key, storage: 'file', created: false });
  });

  it('keeps using an existing key file when the keychain becomes available later', async () => {
    const keychain = new FakeKeychain();
    keychain.mode = 'unavailable';
    const first = await loadOrCreateMasterKey(keychainOpts(keychain));
    keychain.mode = 'ok';
    expect(await loadOrCreateMasterKey(keychainOpts(keychain))).toEqual({ key: first.key, storage: 'file', created: false });
    expect(keychain.entries.size).toBe(0);
  });

  it('never hangs: a stuck keychain call is aborted after the timeout', async () => {
    const keychain = new FakeKeychain();
    keychain.mode = 'hang';
    const started = Date.now();
    const res = await loadOrCreateMasterKey(keychainOpts(keychain, { keychainTimeoutMs: 50 }));
    expect(res.storage).toBe('file');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(keychain.abortedCalls).toBeGreaterThan(0);
  });

  it('falls back to the file when the keychain silently drops writes', async () => {
    const keychain = new FakeKeychain();
    keychain.mode = 'forgetful';
    const res = await loadOrCreateMasterKey(keychainOpts(keychain));
    expect(res.storage).toBe('file');
    expect(await listDir(keyDir)).toEqual([KEY_FILE]);
  });

  it('a malformed keychain value is reported and left untouched', async () => {
    const keychain = new FakeKeychain();
    keychain.entries.set(DEFAULT_ENTRY, 'garbage');
    await expect(loadOrCreateMasterKey(keychainOpts(keychain))).rejects.toThrow(/malformed/);
    expect(keychain.entries.get(DEFAULT_ENTRY)).toBe('garbage');
    expect(await listDir(keyDir)).toEqual([]);
  });

  it.each<[string, (k: FakeKeychain) => void, Partial<KeyStoreOptions>]>([
    ['the entry was removed', (k) => k.entries.clear(), {}],
    ['the keychain is unavailable', (k) => (k.mode = 'unavailable'), {}],
    ['the keychain is disabled', () => undefined, { disableKeychain: true }],
  ])('does not create a new key when the key lives in the keychain but %s', async (_label, breakIt, extra) => {
    const keychain = new FakeKeychain();
    await loadOrCreateMasterKey(keychainOpts(keychain));
    breakIt(keychain);

    await expect(loadOrCreateMasterKey(keychainOpts(keychain, extra))).rejects.toThrow(/No new key was created/);
    expect(await listDir(keyDir)).toEqual([MARKER_FILE]);
  });

  it.runIf(process.platform === 'linux' && !process.env.DBUS_SESSION_BUS_ADDRESS)(
    'real OS keychain without a Secret Service falls back to the key file',
    async () => {
      const opts: KeyStoreOptions = { keyDir, service: `MacroPilotTest-${randomBytes(4).toString('hex')}` };
      const first = await loadOrCreateMasterKey(opts);
      expect(first.storage).toBe('file');
      expect(await loadOrCreateMasterKey(opts)).toEqual({ key: first.key, storage: 'file', created: false });
      await deleteMasterKey(opts);
      expect(await listDir(keyDir)).toEqual([]);
    },
  );
});

describe('storeMasterKey', () => {
  it('stores in the keychain and removes a stale key file', async () => {
    const keychain = new FakeKeychain();
    await mkdir(keyDir, { recursive: true });
    await writeFile(join(keyDir, KEY_FILE), randomBytes(32).toString('base64'));
    const key = randomBytes(32);

    expect(await storeMasterKey(key, keychainOpts(keychain))).toBe('keychain');
    expect(await listDir(keyDir)).toEqual([MARKER_FILE]);
    expect(await loadOrCreateMasterKey(keychainOpts(keychain))).toEqual({ key, storage: 'keychain', created: false });
  });

  it('replaces an existing key file atomically when the keychain is disabled', async () => {
    await loadOrCreateMasterKey(fileOpts());
    const key = randomBytes(32);

    expect(await storeMasterKey(key, fileOpts())).toBe('file');
    expect((await readKeyFile()).trim()).toBe(key.toString('base64'));
    expect(await listDir(keyDir)).toEqual([KEY_FILE]);
    expect(await loadOrCreateMasterKey(fileOpts())).toEqual({ key, storage: 'file', created: false });
  });

  it.skipIf(isWindows)('writes the key file with mode 0600', async () => {
    await storeMasterKey(randomBytes(32), fileOpts());
    expect((await stat(join(keyDir, KEY_FILE))).mode & 0o777).toBe(0o600);
  });

  it('falls back to the file and clears the keychain marker when the keychain fails', async () => {
    const keychain = new FakeKeychain();
    await loadOrCreateMasterKey(keychainOpts(keychain));
    keychain.mode = 'unavailable';
    const key = randomBytes(32);

    expect(await storeMasterKey(key, keychainOpts(keychain))).toBe('file');
    expect(await listDir(keyDir)).toEqual([KEY_FILE]);
  });

  it('removes a stale keychain entry so it cannot shadow the restored key file', async () => {
    const keychain = new FakeKeychain();
    await loadOrCreateMasterKey(keychainOpts(keychain));
    keychain.mode = 'forgetful'; // accepts writes but cannot read them back
    const key = randomBytes(32);

    expect(await storeMasterKey(key, keychainOpts(keychain))).toBe('file');
    expect(keychain.entries.size).toBe(0);
    keychain.mode = 'ok';
    expect(await loadOrCreateMasterKey(keychainOpts(keychain))).toEqual({ key, storage: 'file', created: false });
  });

  it('with an env key: accepts the same key and rejects a different one', async () => {
    const key = randomBytes(32);
    const envKey = key.toString('base64');
    expect(await storeMasterKey(key, fileOpts({ envKey }))).toBe('env');
    await expect(storeMasterKey(randomBytes(32), fileOpts({ envKey }))).rejects.toThrow(/different key/);
    expect(await listDir(keyDir)).toEqual([]);
  });

  it('rejects keys that are not 32 bytes', async () => {
    await expect(storeMasterKey(randomBytes(16), fileOpts())).rejects.toThrow('Master key must be 32 bytes');
  });
});

describe('deleteMasterKey', () => {
  it('removes the keychain entry, the marker and the key file', async () => {
    const keychain = new FakeKeychain();
    await loadOrCreateMasterKey(keychainOpts(keychain));
    await mkdir(keyDir, { recursive: true });
    await writeFile(join(keyDir, KEY_FILE), randomBytes(32).toString('base64'));

    await deleteMasterKey(keychainOpts(keychain));

    expect(keychain.entries.size).toBe(0);
    expect(await listDir(keyDir)).toEqual([]);
    const fresh = await loadOrCreateMasterKey(keychainOpts(keychain));
    expect(fresh.created).toBe(true);
  });

  it('ignores missing entries, files and directories', async () => {
    await expect(deleteMasterKey(fileOpts())).resolves.toBeUndefined();
    await expect(deleteMasterKey(keychainOpts(new FakeKeychain()))).resolves.toBeUndefined();
  });

  it('ignores an unavailable keychain when the key was never stored there', async () => {
    await loadOrCreateMasterKey(fileOpts());
    const keychain = new FakeKeychain();
    keychain.mode = 'unavailable';
    await expect(deleteMasterKey(keychainOpts(keychain))).resolves.toBeUndefined();
    expect(await listDir(keyDir)).toEqual([]);
  });

  it('refuses to forget a keychain key it cannot reach, keeping the marker', async () => {
    const keychain = new FakeKeychain();
    await loadOrCreateMasterKey(keychainOpts(keychain));
    keychain.mode = 'unavailable';

    await expect(deleteMasterKey(keychainOpts(keychain))).rejects.toThrow(/OS keychain/);
    expect(await listDir(keyDir)).toEqual([MARKER_FILE]);
  });
});
