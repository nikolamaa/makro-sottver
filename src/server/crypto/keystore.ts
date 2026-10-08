/**
 * Master key storage. The 256-bit master key (DEK) never lives next to the database.
 *
 * Order of preference:
 *   1. env  - MACROPILOT_MASTER_KEY (base64, 32 bytes). Only for tests/CI/headless use.
 *   2. keychain - OS credential store via optional dependency @napi-rs/keyring
 *                 (Windows Credential Manager / macOS Keychain / Linux Secret Service).
 *   3. file - <keyDir>/master.key (base64), created with mode 0o600, keyDir created with 0o700.
 *             keyDir is a different directory than the data dir (see config.ts).
 */
export type KeyStorage = 'keychain' | 'file' | 'env';

export interface KeyStoreOptions {
  /** Directory for the fallback key file (separate from the data directory). */
  keyDir: string;
  /** Keychain service name, default "MacroPilot". */
  service?: string;
  /** Keychain account name, default "master-key". */
  account?: string;
  /** Skip the OS keychain (tests, or when the user opts out). */
  disableKeychain?: boolean;
  /** Base64 key from the environment; when set it always wins and nothing is persisted. */
  envKey?: string;
}

export interface MasterKeyResult {
  key: Buffer;
  storage: KeyStorage;
  /** True when a new key was generated during this call. */
  created: boolean;
}

/** Load the master key, or generate + persist a new random one if none exists. */
export async function loadOrCreateMasterKey(opts: KeyStoreOptions): Promise<MasterKeyResult> {
  throw new Error('TODO');
}

/** Persist a given key (used when restoring with a recovery key). Returns where it was stored. */
export async function storeMasterKey(key: Buffer, opts: KeyStoreOptions): Promise<KeyStorage> {
  throw new Error('TODO');
}

/** Remove the stored key from keychain and file (used by tests and "reset app"). */
export async function deleteMasterKey(opts: KeyStoreOptions): Promise<void> {
  throw new Error('TODO');
}
