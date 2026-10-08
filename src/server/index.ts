/**
 * MacroPilot entry point: `npm start` (built) or `npm run dev` (tsx watch + Vite).
 * Starts the local server on 127.0.0.1 and opens the browser.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRuntime, KeyMismatchError } from './bootstrap.js';
import { loadConfig } from './config.js';

const log = (msg: string) => process.stdout.write(`[macropilot] ${msg}\n`);

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '""', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
  try {
    const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true });
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
  const config = { ...base, port: await findFreePort(base.host, base.port) };
  const runtime = await createRuntime(config, log);
  await runtime.app.listen({ host: config.host, port: config.port });

  const url = `http://localhost:${config.port}`;
  log(`MacroPilot ${config.version} is running at ${url}`);
  log(`Library: ${runtime.library.count()} macros · data: ${config.dataDir} · key: ${runtime.keyStorage}`);
  if (config.isDev) log('Dev mode: open http://localhost:5173 (Vite) for hot reload.');
  if (config.openBrowser) openBrowser(url);

  const shutdown = async () => {
    log('Shutting down...');
    await runtime.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  if (err instanceof KeyMismatchError) {
    process.stderr.write(`\n[macropilot] ${err.message}\n\n`);
  } else {
    process.stderr.write(`\n[macropilot] Failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  }
  process.exit(1);
});
