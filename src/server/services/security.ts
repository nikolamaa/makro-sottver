/**
 * Recovery-key lifecycle and the master-key consistency check.
 *
 * - On first run a recovery key is generated; it wraps the master key (meta 'recovery_wrapped').
 *   The plain recovery key is kept ENCRYPTED (as a secret) only until the user confirms they saved it.
 * - 'key_check' is an encrypted canary that detects a wrong/lost master key before any data is touched.
 */
import type { SecurityStatus } from '../../shared/types.js';
import type { Cipher } from '../crypto/cipher.js';
import type { KeyStorage } from '../crypto/keystore.js';
import { generateRecoveryKey, wrapMasterKey, type WrappedKey } from '../crypto/recovery.js';
import type { MetaRepo, SettingsRepo } from '../db/repos.js';

const KEY_CHECK_PLAINTEXT = 'macropilot-key-check-v1';
const PENDING_SECRET = 'pending_recovery_key';

/** Returns false when the database was encrypted with a different master key. Creates the canary on first run. */
export function verifyKeyCheck(meta: MetaRepo, cipher: Cipher): boolean {
  const existing = meta.get('key_check');
  if (!existing) {
    meta.set('key_check', cipher.encrypt(KEY_CHECK_PLAINTEXT, 'meta:key_check').toString('base64'));
    return true;
  }
  try {
    return cipher.decrypt(Buffer.from(existing, 'base64'), 'meta:key_check').toString('utf8') === KEY_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

export class SecurityService {
  constructor(
    private readonly meta: MetaRepo,
    private readonly settings: SettingsRepo,
    private readonly masterKey: Buffer,
    private readonly storage: KeyStorage,
    private readonly dataDir: string,
  ) {}

  /** Create the recovery key on first run. Returns true when a new key was generated. */
  ensureRecoveryKey(): boolean {
    if (this.meta.get('recovery_wrapped')) return false;
    const key = generateRecoveryKey();
    this.meta.set('recovery_wrapped', JSON.stringify(wrapMasterKey(this.masterKey, key)));
    this.settings.setSecret(PENDING_SECRET, key);
    this.meta.set('recovery_ack', '0');
    return true;
  }

  wrappedKey(): WrappedKey {
    const raw = this.meta.get('recovery_wrapped');
    if (!raw) throw new Error('Recovery key not initialized');
    return JSON.parse(raw) as WrappedKey;
  }

  status(): SecurityStatus {
    return {
      keyStorage: this.storage,
      recoveryKeyAcknowledged: this.meta.get('recovery_ack') === '1',
      dataDir: this.dataDir,
      encryptedAtRest: true,
    };
  }

  /** The recovery key, only while the user has not confirmed saving it. */
  pendingRecoveryKey(): string | null {
    if (this.meta.get('recovery_ack') === '1') return null;
    return this.settings.getSecret(PENDING_SECRET);
  }

  acknowledge(): SecurityStatus {
    this.meta.set('recovery_ack', '1');
    this.settings.setSecret(PENDING_SECRET, null);
    return this.status();
  }

  /** New recovery key (the old one stops working for new backups). Returned once, never stored in plaintext. */
  rotate(): string {
    const key = generateRecoveryKey();
    this.meta.set('recovery_wrapped', JSON.stringify(wrapMasterKey(this.masterKey, key)));
    this.settings.setSecret(PENDING_SECRET, null);
    this.meta.set('recovery_ack', '1');
    return key;
  }
}
