// Uninstrumented control for measure.mjs: plain Playwright, no Reticle SDK, no daemon.
// Answers "is the page itself too busy at this rate?" before a Reticle timeout is blamed on Reticle.
// For each rate, clicks Buy N times and records the time from click to the row "o-N Filled".
//
// Usage: node bench/high-rate-stream/control.mjs [--n 10] [--rates 0,1000,5000] [--app-port 14463]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../apps/trading-stream');
const { chromium } = createRequire(join(here, '../../server/package.json'))('playwright');
const { values: opt } = parseArgs({
  options: {
    n: { type: 'string', default: '10' },
    rates: { type: 'string', default: '0,1000,5000' },
    'app-port': { type: 'string', default: '14463' },
  },
});
const N = Number(opt.n);
const PORT = Number(opt['app-port']);
const SETTLE_MS = 1500;
const FILL_TIMEOUT_MS = 10_000;

const vite = spawn(join(appDir, 'node_modules/.bin/vite'), [], {
  cwd: appDir,
  env: { ...process.env, RETICLE_MODE: 'outside', APP_PORT: String(PORT), NO_COLOR: '1' },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((ok, fail) => {
  let log = '';
  vite.stdout.on('data', (c) => {
    log += String(c);
    if (log.includes('ready in')) {
      ok();
    }
  });
  vite.on('exit', (code) => fail(new Error(`vite exited ${code}`)));
});

let browser;
try {
  // CHROMIUM_PATH: an installed Chromium, when the one this Playwright expects is not downloaded.
  const executablePath = process.env['CHROMIUM_PATH'];
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  for (const rate of opt.rates.split(',').map(Number)) {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/?rate=${rate}`);
    await page.waitForTimeout(SETTLE_MS);
    const ms = [];
    let missed = 0;
    for (let i = 1; i <= N; i += 1) {
      const t0 = performance.now();
      await page.getByTestId('buy').click();
      try {
        await page
          .getByText(`o-${i} Filled`, { exact: true })
          .waitFor({ timeout: FILL_TIMEOUT_MS });
        ms.push(Math.round(performance.now() - t0));
      } catch {
        missed += 1;
      }
    }
    // How late is the main thread? A 0 ms timer that fires 500 ms late means a busy page.
    const lagMs = await page.evaluate(
      () =>
        new Promise((done) => {
          const t = performance.now();
          setTimeout(() => done(Math.round(performance.now() - t)), 0);
        }),
    );
    ms.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        rate,
        filled: ms.length,
        missed,
        medianMs: ms[Math.floor(ms.length / 2)] ?? null,
        maxMs: ms.at(-1) ?? null,
        timerLagMs: lagMs,
      }),
    );
    await page.close();
  }
} finally {
  await browser?.close();
  try {
    process.kill(-vite.pid, 'SIGTERM');
  } catch {}
}
