#!/usr/bin/env node
/**
 * One-click launcher used by MacroPilot.cmd / macropilot.sh:
 *   1. checks the Node.js version,
 *   2. installs dependencies on first run,
 *   3. (re)builds when sources are newer than the last build,
 *   4. starts the server (which opens the browser).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const stampFile = join(root, 'dist', '.build-stamp');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`MacroPilot needs Node.js 22.13 or newer (found ${process.versions.node}). Download: https://nodejs.org`);
  process.exit(1);
}

function run(args) {
  const r = spawnSync(npm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n"npm ${args.join(' ')}" failed.`);
    process.exit(r.status ?? 1);
  }
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

if (!existsSync(join(root, 'node_modules'))) {
  console.log('[macropilot] First run: installing dependencies (one time, ~1 minute)...');
  run(['install', '--no-audit', '--no-fund']);
}

const sourcesChanged = () => {
  if (!existsSync(stampFile) || !existsSync(join(root, 'dist', 'web', 'index.html'))) return true;
  const built = statSync(stampFile).mtimeMs;
  return newestMtime(join(root, 'src')) > built || statSync(join(root, 'package.json')).mtimeMs > built;
};

if (sourcesChanged()) {
  console.log('[macropilot] Building the app...');
  run(['run', 'build']);
  writeFileSync(stampFile, new Date().toISOString());
}

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});
await import(new URL('../dist/node/server/index.js', import.meta.url).href);
