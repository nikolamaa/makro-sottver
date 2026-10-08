import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_CLIENT_HEADER } from '../shared/api.js';
import { acquireInstanceLock, findRunningInstance, lockFilePath, probeHealth, STARTUP_GRACE_MS, type LockInfo } from './instanceLock.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'macropilot-lock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLock(info: LockInfo): void {
  writeFileSync(lockFilePath(dir), JSON.stringify(info));
}

const OTHER_PID = 999_999;

describe('acquireInstanceLock', () => {
  it('is exclusive, records pid + port and is removed on release', () => {
    const lock = acquireInstanceLock(dir, 4317);
    expect(lock).not.toBeNull();
    const info = JSON.parse(readFileSync(lockFilePath(dir), 'utf8')) as LockInfo;
    expect(info).toMatchObject({ pid: process.pid, port: 4317 });
    if (process.platform !== 'win32') expect(statSync(lockFilePath(dir)).mode & 0o077).toBe(0);

    expect(acquireInstanceLock(dir, 4318)).toBeNull();
    lock!.release();
    expect(existsSync(lockFilePath(dir))).toBe(false);
    lock!.release(); // idempotent

    const again = acquireInstanceLock(dir, 4319);
    expect(again?.info.port).toBe(4319);
    again!.release();
  });

  it('does not remove a lock that another process took over', () => {
    const lock = acquireInstanceLock(dir, 4317)!;
    writeLock({ pid: OTHER_PID, port: 4400, startedAt: Date.now() });
    lock.release();
    expect(existsSync(lockFilePath(dir))).toBe(true);
  });

  it('creates the data folder when needed', () => {
    const nested = join(dir, 'a', 'b');
    const lock = acquireInstanceLock(nested, 4317);
    expect(existsSync(lockFilePath(nested))).toBe(true);
    lock!.release();
  });
});

describe('findRunningInstance', () => {
  const sleep = vi.fn(async () => {});

  it('returns null without a lock', async () => {
    expect(await findRunningInstance(dir, 'token', { probe: async () => true })).toBeNull();
  });

  it('returns the running instance when its process lives and it answers with this token', async () => {
    const info = { pid: OTHER_PID, port: 4400, startedAt: Date.now() - 600_000 };
    writeLock(info);
    const probe = vi.fn(async () => true);
    expect(await findRunningInstance(dir, 'tok', { isAlive: () => true, probe })).toEqual(info);
    expect(probe).toHaveBeenCalledWith(4400, 'tok');
    expect(existsSync(lockFilePath(dir))).toBe(true);
  });

  it('removes a lock whose process is gone', async () => {
    writeLock({ pid: OTHER_PID, port: 4400, startedAt: Date.now() });
    const probe = vi.fn(async () => true);
    expect(await findRunningInstance(dir, 'tok', { isAlive: () => false, probe })).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    expect(existsSync(lockFilePath(dir))).toBe(false);
  });

  it('waits for an instance that is still starting', async () => {
    const t0 = 1_000_000;
    let now = t0;
    writeLock({ pid: OTHER_PID, port: 4400, startedAt: t0 });
    const answers = [false, false, true];
    const probe = vi.fn(async () => answers.shift() ?? true);
    const onWait = vi.fn();
    const found = await findRunningInstance(dir, 'tok', {
      isAlive: () => true,
      probe,
      now: () => now,
      sleep: async () => {
        now += 500;
      },
      onWait,
    });
    expect(found?.port).toBe(4400);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(onWait).toHaveBeenCalledTimes(1);
  });

  it('treats a live process that never answers as stale after the start-up grace period (reused PID)', async () => {
    const t0 = 1_000_000;
    let now = t0;
    writeLock({ pid: OTHER_PID, port: 4400, startedAt: t0 });
    const found = await findRunningInstance(dir, 'tok', {
      isAlive: () => true,
      probe: async () => false,
      now: () => now,
      sleep: async () => {
        now += 10_000;
      },
    });
    expect(found).toBeNull();
    expect(now - t0).toBeGreaterThanOrEqual(STARTUP_GRACE_MS);
    expect(existsSync(lockFilePath(dir))).toBe(false);
  });

  it('ignores a lock that names this very process (left behind by an earlier run with the same PID)', async () => {
    writeLock({ pid: process.pid, port: 4400, startedAt: Date.now() });
    expect(await findRunningInstance(dir, 'tok', { isAlive: () => true, probe: async () => true, sleep })).toBeNull();
    expect(existsSync(lockFilePath(dir))).toBe(false);
  });

  it('removes an old malformed lock', async () => {
    writeFileSync(lockFilePath(dir), 'garbage');
    expect(await findRunningInstance(dir, 'tok', { now: () => Date.now() + 10_000, sleep })).toBeNull();
    expect(existsSync(lockFilePath(dir))).toBe(false);
  });
});

describe('probeHealth', () => {
  let server: Server;
  let port: number;
  const seen: { host?: string; token?: string }[] = [];

  beforeEach(async () => {
    seen.length = 0;
    server = createServer((req, res) => {
      const token = req.headers[API_CLIENT_HEADER];
      seen.push({ host: req.headers.host, token: typeof token === 'string' ? token : undefined });
      if (req.url !== '/api/health' || token !== 'good-token') {
        res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"Missing or invalid access token"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"version":"test"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is true only when the server accepts the access token', async () => {
    expect(await probeHealth(port, 'good-token')).toBe(true);
    expect(await probeHealth(port, 'wrong-token')).toBe(false);
    expect(seen[0]).toEqual({ host: `127.0.0.1:${port}`, token: 'good-token' });
  });

  it('is false when nothing listens', async () => {
    const closed = port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    expect(await probeHealth(closed, 'good-token', 500)).toBe(false);
  });
});
