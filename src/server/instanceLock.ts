/**
 * Single instance per data folder. Two servers on the same database would each keep their own decrypted cache and
 * search index, so edits in one tab would never reach the other. The running server holds
 * `<dataDir>/macropilot.lock` ({ pid, port, startedAt }, created atomically and exclusively, removed on shutdown).
 * A second launch finds it, checks that the instance really answers GET /api/health with this installation's
 * access token, and then opens that instance instead of starting a new one.
 *
 * A lock is stale (and replaced) when its process is gone, or when nothing answers on its port once the start-up
 * grace period has passed (e.g. a crashed server whose PID was reused).
 */
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { API_CLIENT_HEADER } from '../shared/api.js';

export const LOCK_FILE = 'macropilot.lock';
/** How long a live process that holds the lock may take to start answering /api/health. */
export const STARTUP_GRACE_MS = 60_000;
const POLL_MS = 500;

export interface LockInfo {
  pid: number;
  port: number;
  /** Epoch ms when the lock was taken. */
  startedAt: number;
}

export interface InstanceLock {
  readonly file: string;
  readonly info: LockInfo;
  /** Remove the lock file if it is still ours. Idempotent, synchronous (safe in process.on('exit')). */
  release(): void;
}

/** Test seams. */
export interface FindInstanceDeps {
  isAlive?: (pid: number) => boolean;
  probe?: (port: number, token: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once when a live instance holds the lock but does not answer yet (it is probably still starting). */
  onWait?: () => void;
}

export function lockFilePath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function parseLock(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text) as Partial<LockInfo>;
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
    if (ok(v.pid) && ok(v.port) && v.port < 65536 && ok(v.startedAt)) return { pid: v.pid, port: v.port, startedAt: v.startedAt };
  } catch {
    // malformed
  }
  return null;
}

type LockRead = { kind: 'none' } | { kind: 'ok'; info: LockInfo } | { kind: 'malformed'; mtimeMs: number };

function readLock(file: string): LockRead {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(file, 'utf8');
    mtimeMs = statSync(file).mtimeMs;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { kind: 'none' };
    throw err;
  }
  const info = parseLock(text);
  return info ? { kind: 'ok', info } : { kind: 'malformed', mtimeMs };
}

function sameLock(a: LockInfo, b: LockInfo): boolean {
  return a.pid === b.pid && a.port === b.port && a.startedAt === b.startedAt;
}

/** Remove a stale lock unless another process replaced it in the meantime. */
function removeStale(file: string, stale: LockInfo | null): void {
  const current = readLock(file);
  if (current.kind === 'none') return;
  if (stale && (current.kind !== 'ok' || !sameLock(current.info, stale))) return;
  if (!stale && current.kind !== 'malformed') return;
  rmSync(file, { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return isErrno(err, 'EPERM');
  }
}

/** True when a MacroPilot server on 127.0.0.1:port accepts `token` (GET /api/health answers ok). */
export function probeHealth(port: number, token: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/health',
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, [API_CLIENT_HEADER]: token },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (body.length < 64 * 1024) body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(false);
          try {
            resolve((JSON.parse(body) as { ok?: unknown }).ok === true);
          } catch {
            resolve(false);
          }
        });
        res.on('error', () => resolve(false));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * The instance that already serves this data folder, or null when there is none (a stale lock is removed).
 * While a live process holds a fresh lock but does not answer yet (still starting), waits for it.
 */
export async function findRunningInstance(dataDir: string, token: string, deps: FindInstanceDeps = {}): Promise<LockInfo | null> {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const probe = deps.probe ?? ((port: number, t: string) => probeHealth(port, t));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const file = lockFilePath(dataDir);
  let waiting = false;

  for (;;) {
    const read = readLock(file);
    if (read.kind === 'none') return null;
    if (read.kind === 'malformed') {
      // Only a lock being written by a non-atomic fallback is briefly empty; anything older is garbage.
      if (now() - read.mtimeMs < 2000) {
        await sleep(POLL_MS);
        continue;
      }
      removeStale(file, null);
      return null;
    }
    const { info } = read;
    if (info.pid !== process.pid && isAlive(info.pid)) {
      if (await probe(info.port, token)) return info;
      if (now() - info.startedAt < STARTUP_GRACE_MS && isAlive(info.pid)) {
        if (!waiting) deps.onWait?.();
        waiting = true;
        await sleep(POLL_MS);
        continue;
      }
    }
    removeStale(file, info);
    return null;
  }
}

/**
 * Take the lock for this process (atomically: the file appears complete or not at all). Returns null when another
 * process holds it. Removed again by release() and, as a backstop, when the process exits.
 */
export function acquireInstanceLock(dataDir: string, port: number, now: () => number = Date.now): InstanceLock | null {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = lockFilePath(dataDir);
  const info: LockInfo = { pid: process.pid, port, startedAt: now() };
  const content = `${JSON.stringify(info)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  let acquired = false;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    linkSync(tmp, file);
    acquired = true;
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) {
      // File system without hard links: exclusive create still guarantees a single owner.
      try {
        writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
        acquired = true;
      } catch (err2) {
        if (!isErrno(err2, 'EEXIST')) throw err2;
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  if (!acquired) return null;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    try {
      const current = readLock(file);
      if (current.kind === 'ok' && sameLock(current.info, info)) rmSync(file, { force: true });
    } catch {
      // Best effort: a lock left behind is detected as stale on the next start.
    }
  };
  process.once('exit', release);
  return { file, info, release };
}
