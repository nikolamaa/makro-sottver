/**
 * Encrypted backup container (.mpbackup). Lets the user move their library to another computer.
 * The file is JSON:
 *   { "format": "macropilot-backup", "v": 1, "createdAt": ISO, "wrappedKey": WrappedKey,
 *     "payload": base64(Cipher(masterKey).encryptJson(payload, "backup:v1")) }
 * Restoring requires the recovery key: unwrap the master key, then decrypt the payload.
 */
import type { WrappedKey } from './recovery.js';

export interface BackupContainer {
  format: 'macropilot-backup';
  v: 1;
  createdAt: string;
  wrappedKey: WrappedKey;
  payload: string;
}

/** Serialize `payload` (any JSON value) into an encrypted backup file (UTF-8 JSON bytes). */
export function createBackup(payload: unknown, masterKey: Buffer, wrappedKey: WrappedKey): Buffer {
  throw new Error('TODO');
}

/** Parse + decrypt a backup file with the recovery key. Throws a clear Error on wrong key / bad file. */
export function readBackup<T = unknown>(file: Buffer | string, recoveryKey: string): { payload: T; masterKey: Buffer; createdAt: string } {
  throw new Error('TODO');
}
