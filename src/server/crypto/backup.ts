/**
 * Encrypted backup container (.mpbackup). Lets the user move their library to another computer.
 * The file is JSON:
 *   { "format": "macropilot-backup", "v": 1, "createdAt": ISO, "wrappedKey": WrappedKey,
 *     "payload": base64(Cipher(masterKey).encryptJson(payload, "backup:v1")) }
 * Restoring requires the recovery key: unwrap the master key, then decrypt the payload.
 */
import { createCipher } from './cipher.js';
import { isWrappedKey, unwrapMasterKey, type WrappedKey } from './recovery.js';

export interface BackupContainer {
  format: 'macropilot-backup';
  v: 1;
  createdAt: string;
  wrappedKey: WrappedKey;
  payload: string;
}

const FORMAT = 'macropilot-backup';
const VERSION = 1;
const PAYLOAD_AAD = 'backup:v1';
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** Some editors/transfer tools prepend a UTF-8 byte order mark, which JSON.parse rejects. */
const BOM_RE = /^\uFEFF/;

const CORRUPTED = 'Backup file is corrupted';

/**
 * Serialize `payload` (any JSON value) into an encrypted backup file (UTF-8 JSON bytes).
 * Throws when the payload is undefined or `wrappedKey` is malformed (the backup could never be restored).
 */
export function createBackup(payload: unknown, masterKey: Buffer, wrappedKey: WrappedKey): Buffer {
  if (payload === undefined) throw new Error('Backup payload must be a JSON value');
  if (!isWrappedKey(wrappedKey)) throw new Error('Invalid wrapped key');
  const container: BackupContainer = {
    format: FORMAT,
    v: VERSION,
    createdAt: new Date().toISOString(),
    wrappedKey,
    payload: createCipher(masterKey).encryptJson(payload, PAYLOAD_AAD).toString('base64'),
  };
  return Buffer.from(JSON.stringify(container), 'utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(CORRUPTED);
  }
}

/** Validate the container envelope; errors name the problem without echoing file content. */
function parseContainer(file: Buffer | string): BackupContainer {
  const text = typeof file === 'string' ? file : file.toString('utf8');
  const data = parseJson(text.replace(BOM_RE, ''));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(CORRUPTED);
  const c = data as Record<string, unknown>;
  if (c.format !== FORMAT) throw new Error('Not a MacroPilot backup file');
  if (c.v !== VERSION) {
    throw new Error('Unsupported backup version (the file was probably created by a newer MacroPilot)');
  }
  if (typeof c.createdAt !== 'string' || !isWrappedKey(c.wrappedKey)) throw new Error(CORRUPTED);
  if (typeof c.payload !== 'string' || !BASE64_RE.test(c.payload)) throw new Error(CORRUPTED);
  return c as unknown as BackupContainer;
}

function decryptPayload<T>(payload: string, masterKey: Buffer): T {
  try {
    return createCipher(masterKey).decryptJson<T>(Buffer.from(payload, 'base64'), PAYLOAD_AAD);
  } catch {
    throw new Error(CORRUPTED);
  }
}

/**
 * Parse + decrypt a backup file with the recovery key. Throws a clear Error on wrong key / bad file:
 *   'Invalid recovery key format' - the recovery key is not MPRK-shaped
 *   'Invalid recovery key'        - the recovery key does not unlock this backup
 *   'Backup file is corrupted'    - not JSON, fields missing/malformed, or payload fails authentication
 *   'Not a MacroPilot backup file' / 'Unsupported backup version …' - wrong file type or newer format
 */
export function readBackup<T = unknown>(file: Buffer | string, recoveryKey: string): { payload: T; masterKey: Buffer; createdAt: string } {
  const container = parseContainer(file);
  const masterKey = unwrapMasterKey(container.wrappedKey, recoveryKey); // normalizes the key first
  return { payload: decryptPayload<T>(container.payload, masterKey), masterKey, createdAt: container.createdAt };
}
