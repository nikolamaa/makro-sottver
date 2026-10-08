/**
 * MacroPilot entry point: `npm start` (built) or `npm run dev` (tsx watch + Vite).
 * Starts the local server on 127.0.0.1 and opens the browser with the access link (the access token travels in
 * the URL fragment, which is never sent to the server; the UI keeps it in localStorage).
 * Only one server runs per data folder: a second launch opens the running one and exits (see instanceLock.ts).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRuntime, KeyMismatchError, loadMasterKey } from './bootstrap.js';
import { loadConfig } from './config.js';
import { acquireInstanceLock, findRunningInstance, type InstanceLock } from './instanceLock.js';
import { deriveAccessToken } from './services/security.js';

const log = (msg: string) => process.stdout.write(`[macropilot] ${msg}\n`);

/** The page the browser opens: the access token rides in the fragment (`#/assist?k=...`, parsed by src/web/access.ts). */
function accessLink(origin: string, token: string): string {
  return `${origin}/#/assist?k=${encodeURIComponent(token)}`;
}

function openBrowser(url: string): void {
  // Windows: `start` through cmd with the URL quoted verbatim, so '?', '=' and '#' reach the browser unchanged.
  const cmd =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/d', '/s', '/c', 'start', '""', '/b', `"${url}"`] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
  try {
    const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.on('error', () => log(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    log(`Open ${url} in your browser.`);
  }
}

/** First free port in [start, start+10] on 127.0.0.1. */
async function findFreePort(host: string, start: number): Promise<number> {
  for (let port = start; port <= start + 10; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.listen({ host, port }, () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`No free port between ${start} and ${start + 10}`);
}

async function main(): Promise<void> {
  const base = loadConfig();
  const masterKey = await loadMasterKey(base);
  const token = deriveAccessToken(masterKey.key);

  // Single instance per data folder: open the running server instead of starting a second one on the same database.
  let lock: InstanceLock | null = null;
  for (let attempt = 0; !lock; attempt++) {
    const running = await findRunningInstance(base.dataDir, token, {
      onWait: () => log('Another MacroPilot is starting for this data folder - waiting for it...'),
    });
    if (running) {
      const link = accessLink(`http://localhost:${running.port}`, token);
      log(`MacroPilot is already running for this data folder. Open: ${link}`);
      if (base.openBrowser) openBrowser(link);
      process.exit(0);
    }
    if (attempt >= 5) throw new Error(`Could not take the instance lock in ${base.dataDir}`);
    lock = acquireInstanceLock(base.dataDir, await findFreePort(base.host, base.port));
  }

  const config = { ...base, port: lock.info.port };
  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  try {
    runtime = await createRuntime(config, log, { masterKey });
    await runtime.app.listen({ host: config.host, port: config.port });
  } catch (err) {
    lock.release();
    throw err;
  }

  const link = accessLink(`http://localhost:${config.port}`, token);
  log(`MacroPilot ${config.version} is running at ${link}`);
  log('Keep this link private: it opens your library. The launcher opens it for you.');
  log(`Library: ${runtime.library.count()} macros · data: ${config.dataDir} · key: ${runtime.keyStorage}`);
  if (config.isDev) log(`Dev mode: open ${accessLink('http://localhost:5173', token)} (Vite) for hot reload.`);
  if (config.openBrowser) openBrowser(link);

  const heldLock = lock;
  const shutdown = async () => {
    log('Shutting down...');
    try {
      await runtime.close();
    } finally {
      heldLock.release();
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGHUP', () => void shutdown());
}

main().catch((err: unknown) => {
  if (err instanceof KeyMismatchError) {
    process.stderr.write(`\n[macropilot] ${err.message}\n\n`);
  } else {
    process.stderr.write(`\n[macropilot] Failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  }
  process.exit(1);
});
