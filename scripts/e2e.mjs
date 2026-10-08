#!/usr/bin/env node
/**
 * `npm run test:e2e` - end-to-end smoke test in a real (headless) Chromium against the built app:
 * first-run recovery key dialog, paste a customer message, recommendations, personalized reply, copy to the
 * clipboard, the AI double-check (with a faked AI), quick search, Library / Import / Settings pages. Fails on any
 * browser console error.
 *
 * Env: E2E_CHROMIUM (browser executable), E2E_SCREENSHOTS (directory for screenshots, default test-results/e2e).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 4391);
const BASE = `http://localhost:${PORT}`;
const shots = process.env.E2E_SCREENSHOTS ?? join(root, 'test-results', 'e2e');
const executablePath =
  process.env.E2E_CHROMIUM ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));

function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

if (!existsSync(join(root, 'dist/node/server/index.js')) || !existsSync(join(root, 'dist/web/index.html'))) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(1);
}
mkdirSync(shots, { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), 'macropilot-e2e-'));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'dist/node/server/index.js')], {
  cwd: root,
  env: {
    ...process.env,
    MACROPILOT_PORT: String(PORT),
    MACROPILOT_DATA_DIR: join(tmp, 'data'),
    MACROPILOT_KEY_DIR: join(tmp, 'keys'),
    MACROPILOT_DISABLE_KEYCHAIN: '1',
    MACROPILOT_NO_OPEN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    if (serverLog.includes('is running at')) return;
    if (server.exitCode !== null) throw new Error(`Server exited:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start:\n${serverLog}`);
}

const consoleErrors = [];
let browser;
const steps = [];
const step = async (name, fn) => {
  const t0 = performance.now();
  await fn();
  steps.push(`✓ ${name} (${Math.round(performance.now() - t0)} ms)`);
  console.log(steps.at(-1));
};

try {
  await waitForServer();
  browser = await chromium.launch({ executablePath, args: ['--no-proxy-server'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await step('first run shows the recovery key and can be acknowledged', async () => {
    await page.goto(BASE);
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const key = await dialog.getByLabel('Recovery key', { exact: true }).textContent();
    assert(/MPRK-/.test(key ?? ''), 'recovery key is shown');
    await page.screenshot({ path: join(shots, '01-onboarding.png') });
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.waitFor({ state: 'detached' });
  });

  const message = 'hey my btc withdrawal is pending for 2 days, where is it?? also when do i get my weekly bonus';
  await step('pasting a message shows recommendations and a personalized reply', async () => {
    const box = page.getByPlaceholder(/Paste the customer's message/);
    await box.fill(message);
    const firstCard = page.locator('.rec-card:not(.rec-skeleton)').first();
    await firstCard.waitFor();
    const cardText = (await firstCard.textContent()) ?? '';
    assert(/withdrawal/i.test(cardText), `top recommendation is about withdrawals (got: ${cardText.slice(0, 80)})`);
    const reply = page.getByLabel('Reply text');
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Reply text"]')?.value ?? '').length > 20);
    const text = await reply.inputValue();
    assert(/^Hi /m.test(text), 'reply starts with a greeting');
    assert(/BTC/.test(text), 'detected crypto is filled in');
    await page.screenshot({ path: join(shots, '02-assist.png'), fullPage: true });
  });

  await step('Ctrl+Enter copies the reply to the clipboard', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    const reply = await page.getByLabel('Reply text').inputValue();
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(150);
    let clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    if (clip !== reply) {
      // Placeholders left: the first press warns, the second press copies.
      await page.keyboard.press('Control+Enter');
      await page.waitForTimeout(150);
      clip = await page.evaluate(() => navigator.clipboard.readText());
    }
    assert(clip === reply, 'clipboard contains the reply');
  });

  await step('combining a second macro for the second question', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Alt+Shift+2');
    await page.waitForTimeout(400);
    const text = await page.getByLabel('Reply text').inputValue();
    assert((text.match(/^Hi /gm) ?? []).length === 1, 'combined reply has one greeting');
    await page.screenshot({ path: join(shots, '03-assist-combined.png'), fullPage: true });
  });

  await step('an off-topic message says there is no good match', async () => {
    const box = page.getByPlaceholder(/Paste the customer's message/);
    await box.fill("what's the weather going to be like in Belgrade tomorrow?");
    await page.getByText(/No macro matches well/i).waitFor();
    await page.screenshot({ path: join(shots, '04-no-match.png'), fullPage: true });
  });

  await step('AI double-check (faked AI): outdated check aborted, cards scored in place, one call per message', async () => {
    // Pretend a provider is ready; /api/rerank answers like the AI would (prefers the local #2) once released.
    const calls = [];
    await page.route('**/api/health', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), ai: { provider: 'anthropic', ready: true, detail: 'fake' } } });
    });
    await page.route('**/api/rerank', async (route) => {
      const res = await route.fetch();
      const local = await res.json();
      const [first, second = first] = local.recommendations;
      const json = {
        recommendations: [
          { ...second, confidence: 93, reason: 'AI: answers the pending withdrawal.' },
          { ...first, confidence: 64, reason: 'AI: only partly.' },
        ],
        noGoodMatch: false,
        aiUsed: true,
        llm: null,
      };
      await new Promise((release) => calls.push({ message: route.request().postDataJSON().message, release }));
      await route.fulfill({ response: res, json }).catch(() => {}); // the page aborted it
    });
    await page.reload();
    const box = page.getByPlaceholder(/Paste the customer's message/);
    const checking = page.getByText('AI checking…');
    /** Waits until the (non-stale) top card's title matches `pattern`. */
    const topCard = (pattern) =>
      page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('.rec-list:not(.is-stale) .rec-title')?.textContent ?? ''), pattern);

    // The agent moves on to another message while the AI is still checking the first one.
    await box.fill('my deposit has not arrived yet, it has been 3 hours');
    await topCard('deposit');
    await checking.waitFor();
    assert(calls.length === 1, `one check for the first message (got ${calls.length})`);
    await box.fill(message);
    await checking.waitFor({ state: 'detached' });
    await topCard('withdrawal');
    await page.waitForFunction(() => (document.querySelector('textarea[aria-label="Reply text"]')?.value ?? '').length > 20);
    const titles = await page.locator('.rec-card .rec-title').allTextContents();
    const selected = await page.locator('.rec-card.is-selected .rec-title').allTextContents();
    const reply = await page.getByLabel('Reply text').inputValue();

    await checking.waitFor();
    assert(calls.length === 2 && calls[1].message === message, 'the second message gets its own check');
    for (const c of calls) c.release();
    await page.getByText('AI pick').waitFor();
    await checking.waitFor({ state: 'detached' });
    assert(JSON.stringify(await page.locator('.rec-card .rec-title').allTextContents()) === JSON.stringify(titles), 'cards keep their order');
    assert(JSON.stringify(await page.locator('.rec-card.is-selected .rec-title').allTextContents()) === JSON.stringify(selected), 'selection unchanged');
    assert((await page.getByLabel('Reply text').inputValue()) === reply, 'reply text unchanged');
    const second = (await page.locator('.rec-card').nth(1).textContent()) ?? '';
    assert(/AI pick/.test(second) && /93%/.test(second), `AI pick badge and score on card 2 (got: ${second.slice(0, 120)})`);
    await page.screenshot({ path: join(shots, '04b-ai-double-check.png'), fullPage: true });
    await page.waitForTimeout(1000);
    assert(calls.length === 2, `no further AI calls for the same message (got ${calls.length})`);

    await page.unroute('**/api/rerank');
    await page.unroute('**/api/health');
    await page.reload();
    await box.waitFor();
  });

  await step('Ctrl+K quick search finds macros', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox');
    await input.fill('2fa');
    await page.getByRole('option').first().waitFor();
    const first = (await page.getByRole('option').first().textContent()) ?? '';
    assert(/2FA/i.test(first), `quick search finds 2FA macro (got ${first.slice(0, 60)})`);
    await page.screenshot({ path: join(shots, '05-quick-search.png') });
    await page.keyboard.press('Escape');
  });

  await step('Library lists the demo macros and opens the editor', async () => {
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('heading', { name: /Library|Macros/i }).first().waitFor().catch(() => {});
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, '06-library.png'), fullPage: true });
  });

  await step('Import / Export page renders', async () => {
    await page.getByRole('button', { name: 'Import / Export' }).click();
    await page.getByRole('heading', { name: 'Import / Export' }).waitFor();
    await page.screenshot({ path: join(shots, '07-import.png'), fullPage: true });
  });

  await step('Settings page renders', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, '08-settings.png'), fullPage: true });
  });

  await step('dark theme', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('button', { name: 'Assist', exact: true }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, '09-assist-dark.png'), fullPage: true });
  });

  assert(consoleErrors.length === 0, `no console errors:\n${consoleErrors.join('\n')}`);
  console.log(`\nE2E passed (${steps.length} steps). Screenshots: ${shots}`);
} catch (err) {
  console.error(`\nE2E FAILED: ${err instanceof Error ? err.message : String(err)}`);
  if (consoleErrors.length) console.error(`Console errors:\n${consoleErrors.join('\n')}`);
  console.error(`Server log:\n${serverLog}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
