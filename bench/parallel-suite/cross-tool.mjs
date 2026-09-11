/**
 * Serial vs parallel, measured the SAME way for both tools.
 *
 * The existing parallel bench measures Reticle against itself, which answers "does leasing help?" but
 * not "does it help more than what I already have?". A buyer running a Playwright suite already has
 * worker parallelism, so the honest comparison is each tool's own native concurrency primitive doing
 * the same work on the same machine against the same app.
 *
 * Both sides here run N independent journeys over one browser:
 *   - serial:   one context, journeys back to back
 *   - parallel: N isolated contexts, journeys concurrently
 *
 * `playwright` (the library) is used rather than `@playwright/test` deliberately: adding a test-runner
 * dependency just to run a benchmark would change the thing being measured, and browser.newContext() is
 * exactly the primitive Reticle's lease pool uses — so the two sides are doing the same work, not one
 * doing a framework's work.
 *
 * WHAT THIS DOES NOT SHOW: it compares CONCURRENCY MECHANICS on identical journeys. It does not say the
 * journeys are equally valuable — that is what the detection scorecard is for. A tool can be faster at
 * running checks that catch less.
 *
 *   node bench/parallel-suite/cross-tool.mjs [appUrl] [flows] [parallelism]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.argv[2] ?? 'http://localhost:4312';
const FLOWS = Number(process.argv[3] ?? 8);
const PARALLELISM = Number(process.argv[4] ?? 4);
const HERE = dirname(fileURLToPath(import.meta.url));

const sel = (t) => `[data-testid="${t}"]`;

/**
 * One journey: log in, visit two views, act, and read back. Deliberately modest — a heavier journey
 * would inflate the speedup for BOTH tools and make the ratio look better than the mechanism deserves.
 */
async function journey(context) {
  const page = await context.newPage();
  try {
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.locator(sel('login-submit')).click({ timeout: 8000 });
    await page.locator(sel('nav-deployments')).click({ timeout: 8000 });
    await page.locator(sel('nav-compose')).click({ timeout: 8000 });
    await page.locator(sel('compose-prompt')).fill('parallel bench');
    await page.locator(sel('compose-generate')).click({ timeout: 8000 });
    await page.locator(sel('compose-result')).waitFor({ state: 'attached', timeout: 8000 });
    return true;
  } catch {
    return false;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Run `count` journeys through one shared context, back to back. */
async function serial(browser, count) {
  const context = await browser.newContext();
  const t0 = Date.now();
  let ok = 0;
  for (let i = 0; i < count; i += 1) if (await journey(context)) ok += 1;
  const ms = Date.now() - t0;
  await context.close();
  return { ms, ok, count };
}

/** Run `count` journeys across at most `width` isolated contexts, concurrently. */
async function parallel(browser, count, width) {
  const t0 = Date.now();
  let ok = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= count) return;
      const context = await browser.newContext();
      try {
        if (await journey(context)) ok += 1;
      } finally {
        await context.close().catch(() => undefined);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, count) }, worker));
  return { ms: Date.now() - t0, ok, count };
}

const browser = await chromium.launch();
try {
  // Warm the app once so neither mode pays first-compile cost — otherwise whichever runs first loses.
  const warm = await browser.newContext();
  await journey(warm);
  await warm.close();

  const s = await serial(browser, FLOWS);
  const p = await parallel(browser, FLOWS, PARALLELISM);

  const speedup = s.ms / p.ms;
  const result = {
    tool: 'playwright-library',
    app: APP,
    flows: FLOWS,
    parallelism: PARALLELISM,
    serial: s,
    parallel: p,
    speedup: Number(speedup.toFixed(2)),
    // A faster run that completed fewer journeys is not faster. Recorded so the ratio cannot be read
    // without its denominator.
    comparable: s.ok === p.ok && s.ok === FLOWS,
  };
  mkdirSync(join(HERE, '..', 'raw'), { recursive: true });
  writeFileSync(
    join(HERE, '..', 'raw', 'cross-tool-parallel.json'),
    JSON.stringify(result, null, 2),
  );

  console.log(
    `\n=== Playwright: serial vs parallel (${FLOWS} journeys, width ${PARALLELISM}) ===\n`,
  );
  console.log(`serial    ${s.ms} ms  (${s.ok}/${s.count} journeys completed)`);
  console.log(`parallel  ${p.ms} ms  (${p.ok}/${p.count} journeys completed)`);
  console.log(`speedup   ${speedup.toFixed(2)}x`);
  if (!result.comparable) {
    console.log('\nNOT COMPARABLE: the two modes completed different numbers of journeys.');
    console.log(
      'A speedup over fewer completions is not a speedup. Fix the fixture before quoting this.',
    );
    process.exitCode = 1;
  }
  console.log(
    '\nCompare against bench/parallel-suite/measure.mjs (Reticle serial vs leased-parallel).',
  );
  console.log('Both use one browser and N isolated contexts, so the mechanism is like-for-like.');
} finally {
  await browser.close();
}
