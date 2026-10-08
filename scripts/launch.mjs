#!/usr/bin/env node
/**
 * One-click launcher used by MacroPilot.cmd / macropilot.sh:
 *   1. checks the Node.js version,
 *   2. installs dependencies on first run, and again after an update changed package.json / package-lock.json,
 *   3. (re)builds when sources are newer than the last build (always after a dependency install),
 *   4. starts the server (which opens the browser, or opens the already running MacroPilot).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

function run(args, hint = '') {
  const r = spawnSync(npm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n"npm ${args.join(' ')}" failed.${hint}`);
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

const mtime = (file) => (existsSync(file) ? statSync(file).mtimeMs : 0);
/** npm's record of the installed tree; older than package.json / package-lock.json means an update changed dependencies. */
const installMarker = join(root, 'node_modules', '.package-lock.json');

function dependenciesOutdated() {
  if (!existsSync(installMarker)) return true;
  const installed = mtime(installMarker);
  return mtime(join(root, 'package.json')) > installed || mtime(join(root, 'package-lock.json')) > installed;
}

let installed = false;
if (!existsSync(join(root, 'node_modules')) || dependenciesOutdated()) {
  console.log(
    existsSync(join(root, 'node_modules'))
      ? '[macropilot] Dependencies changed: updating them (about a minute)...'
      : '[macropilot] First run: installing dependencies (one time, ~1 minute)...',
  );
  run(['install', '--no-audit', '--no-fund']);
  // npm may rewrite package-lock.json after its marker: mark the install as current so the next start skips it.
  if (existsSync(installMarker)) {
    const now = new Date();
    utimesSync(installMarker, now, now);
  }
  installed = true;
}

const sourcesChanged = () => {
  if (!existsSync(stampFile) || !existsSync(join(root, 'dist', 'web', 'index.html'))) return true;
  const built = statSync(stampFile).mtimeMs;
  return newestMtime(join(root, 'src')) > built || statSync(join(root, 'package.json')).mtimeMs > built;
};

if (installed || sourcesChanged()) {
  console.log('[macropilot] Building the app...');
  run(['run', 'build'], ' If it says a module cannot be found, run "npm install" in this folder and start MacroPilot again.');
  writeFileSync(stampFile, new Date().toISOString());
}

process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});
await import(new URL('../dist/node/server/index.js', import.meta.url).href);
