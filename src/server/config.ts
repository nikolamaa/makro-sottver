/**
 * Runtime configuration. Data and the fallback key file live in DIFFERENT directories so that copying the data
 * folder (or a synced/backed-up copy of it leaking) never exposes the key.
 *
 * Environment overrides:
 *   MACROPILOT_PORT             default 4317 (the next free port up to +10 is used if busy)
 *   MACROPILOT_DATA_DIR         encrypted database location
 *   MACROPILOT_KEY_DIR          fallback key-file location (used only when no OS keychain is available)
 *   MACROPILOT_MASTER_KEY       base64 32-byte key (tests/CI only)
 *   MACROPILOT_DISABLE_KEYCHAIN 1 = never use the OS keychain
 *   MACROPILOT_NO_OPEN          1 = don't open the browser on start
 *   MACROPILOT_NO_SEED          1 = don't load the demo macros on first run
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  version: string;
  host: '127.0.0.1';
  port: number;
  dataDir: string;
  keyDir: string;
  dbFile: string;
  modelCacheDir: string;
  /** Built web UI (dist/web) or null when not built (dev mode uses Vite). */
  webDir: string | null;
  seedFile: string | null;
  openBrowser: boolean;
  seedOnFirstRun: boolean;
  envMasterKey: string | undefined;
  disableKeychain: boolean;
  isDev: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root: works from src/server (tsx) and dist/node/server (compiled). */
function findRoot(): string {
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function defaultDirs(env: NodeJS.ProcessEnv): { dataDir: string; keyDir: string } {
  const home = homedir();
  if (process.platform === 'win32') {
    const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return { dataDir: join(roaming, 'MacroPilot', 'data'), keyDir: join(local, 'MacroPilot', 'keys') };
  }
  if (process.platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return { dataDir: join(support, 'MacroPilot', 'data'), keyDir: join(support, 'MacroPilot Keys') };
  }
  const dataHome = env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  const configHome = env.XDG_CONFIG_HOME ?? join(home, '.config');
  return { dataDir: join(dataHome, 'macropilot'), keyDir: join(configHome, 'macropilot', 'keys') };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const root = findRoot();
  const isDev = here.includes(`${join('src', 'server')}`);
  let version = '0.0.0';
  try {
    version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? version;
  } catch {
    /* keep default */
  }

  const defaults = isDev
    ? { dataDir: join(root, '.macropilot-data', 'data'), keyDir: join(root, '.macropilot-data', 'keys') }
    : defaultDirs(env);
  const dataDir = resolve(env.MACROPILOT_DATA_DIR ?? defaults.dataDir);
  const keyDir = resolve(env.MACROPILOT_KEY_DIR ?? defaults.keyDir);

  const webCandidate = join(root, 'dist', 'web');
  const seedCandidate = join(root, 'seed', 'stake-demo-macros.json');
  const port = Number(env.MACROPILOT_PORT ?? 4317);

  return {
    version,
    host: '127.0.0.1',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4317,
    dataDir,
    keyDir,
    dbFile: join(dataDir, 'macropilot.db'),
    modelCacheDir: join(dataDir, 'models'),
    webDir: existsSync(join(webCandidate, 'index.html')) ? webCandidate : null,
    seedFile: existsSync(seedCandidate) ? seedCandidate : null,
    openBrowser: env.MACROPILOT_NO_OPEN !== '1' && !isDev,
    seedOnFirstRun: env.MACROPILOT_NO_SEED !== '1',
    envMasterKey: env.MACROPILOT_MASTER_KEY || undefined,
    disableKeychain: env.MACROPILOT_DISABLE_KEYCHAIN === '1',
    isDev,
  };
}
