/**
 * `npm run recover` - restore access to an existing encrypted library after the master key was lost
 * (e.g. new Windows profile, cleared keychain). Asks for the recovery key, unwraps the master key stored in the
 * database, verifies it, and saves it to the OS keychain (or key file) again.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync } from 'node:fs';
import { createCipher } from './crypto/cipher.js';
import { storeMasterKey } from './crypto/keystore.js';
import { unwrapMasterKey, type WrappedKey } from './crypto/recovery.js';
import { openDatabase } from './db/database.js';
import { MetaRepo } from './db/repos.js';
import { verifyKeyCheck } from './services/security.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (!existsSync(config.dbFile)) {
    console.error(`No MacroPilot database found at ${config.dbFile}`);
    process.exit(1);
  }
  const db = openDatabase(config.dbFile);
  const meta = new MetaRepo(db);
  const wrappedRaw = meta.get('recovery_wrapped');
  if (!wrappedRaw) {
    console.error('This database has no recovery key information.');
    process.exit(1);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('Recovery key (MPRK-....): ');
  rl.close();
  let key: Buffer;
  try {
    key = unwrapMasterKey(JSON.parse(wrappedRaw) as WrappedKey, answer);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!verifyKeyCheck(meta, createCipher(key))) {
    console.error('The recovered key does not match this database.');
    process.exit(1);
  }
  db.close();
  const storage = await storeMasterKey(key, { keyDir: config.keyDir, disableKeychain: config.disableKeychain });
  console.log(`Access restored. The key is stored in: ${storage}. Start MacroPilot again.`);
}

void main();
