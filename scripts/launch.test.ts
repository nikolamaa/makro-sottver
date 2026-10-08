/**
 * Black-box test of the one-click launcher in a throw-away folder, with a fake `npm` on PATH that records calls.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const launcher = fileURLToPath(new URL('./launch.mjs', import.meta.url));
let dir: string;

const FAKE_NPM = `#!/bin/sh
echo "$*" >> "$(dirname "$0")/../npm-calls.log"
if [ "$1" = "install" ]; then mkdir -p node_modules && echo '{}' > node_modules/.package-lock.json; fi
exit 0
`;

function setAge(file: string, secondsAgo: number): void {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(file, t, t);
}

function launch(): { status: number | null; npmCalls: string[]; output: string } {
  writeFileSync(join(dir, 'npm-calls.log'), '');
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'launch.mjs')], {
    cwd: dir,
    env: { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });
  const npmCalls = readFileSync(join(dir, 'npm-calls.log'), 'utf8').split('\n').filter(Boolean);
  return { status: r.status, npmCalls, output: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'macropilot-launch-'));
  for (const d of ['scripts', 'bin', 'src', 'node_modules', 'dist/web', 'dist/node/server']) mkdirSync(join(dir, d), { recursive: true });
  copyFileSync(launcher, join(dir, 'scripts', 'launch.mjs'));
  writeFileSync(join(dir, 'bin', 'npm'), FAKE_NPM);
  chmodSync(join(dir, 'bin', 'npm'), 0o755);
  writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  writeFileSync(join(dir, 'src', 'a.ts'), '');
  writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}');
  writeFileSync(join(dir, 'dist', 'web', 'index.html'), '');
  writeFileSync(join(dir, 'dist', 'node', 'server', 'index.js'), 'console.log("server started");\n');
  writeFileSync(join(dir, 'dist', '.build-stamp'), '');
  // Installed and built after the sources were last changed.
  for (const f of ['package.json', 'package-lock.json', 'src/a.ts']) setAge(join(dir, f), 300);
  setAge(join(dir, 'node_modules', '.package-lock.json'), 200);
  setAge(join(dir, 'dist', '.build-stamp'), 100);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('launch.mjs', () => {
  it('starts without npm when nothing changed', () => {
    const r = launch();
    expect(r.status).toBe(0);
    expect(r.npmCalls).toEqual([]);
    expect(r.output).toContain('server started');
  });

  it('re-installs and rebuilds after an update changed package-lock.json, then not again', () => {
    setAge(join(dir, 'package-lock.json'), 0);
    const first = launch();
    expect(first.status).toBe(0);
    expect(first.npmCalls).toEqual(['install --no-audit --no-fund', 'run build']);
    const second = launch();
    expect(second.npmCalls).toEqual([]);
  });

  it('re-installs when package.json is newer than the installed tree', () => {
    setAge(join(dir, 'package.json'), 0);
    expect(launch().npmCalls).toEqual(['install --no-audit --no-fund', 'run build']);
  });

  it('re-installs when npm never recorded an install', () => {
    rmSync(join(dir, 'node_modules', '.package-lock.json'));
    expect(launch().npmCalls[0]).toBe('install --no-audit --no-fund');
  });

  it('only rebuilds when just the sources changed', () => {
    setAge(join(dir, 'src', 'a.ts'), 0);
    expect(launch().npmCalls).toEqual(['run build']);
  });
});
