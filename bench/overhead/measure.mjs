// SDK overhead budget. "An observability layer that slows the app corrupts its own perf
// verdicts", so the release bar is: total instrumentation overhead (stacks, store subscriptions,
// journal writes, DOM/network observers) < 3% of main-thread time, measured on the HOSTILE fixture —
// the page that never goes quiet, i.e. the worst realistic case.
//
// Method: load the same hostile page in the same browser under THREE conditions and read Chrome's own
// cumulative `TaskDuration` over an identical wall-clock window. Overhead is a difference expressed as a
// share of that window, so it is main-thread PERCENTAGE POINTS, not a ratio of an arbitrary baseline.
//
//   full      — instrumentation + the presenter HUD (what a developer sees by default)
//   observers — `?nopresent`: every observer installed, no HUD          <-- the budget applies HERE
//   none      — `?no-hud`: Reticle skipped entirely
//
// The third condition is the point. The budget's sentence is "what does INSTRUMENTING cost the app",
// but the two-condition version compared `full` against `none`, so it charged instrumentation for the
// HUD as well — and the HUD is a full-viewport element with an infinite box-shadow animation and a
// backdrop-filter, i.e. per-FRAME paint work that has nothing to do with observing anything. Reporting
// them as one number both overstates the cost of instrumentation and hides the cost of the HUD.
// Decomposed:  instrumentation = observers - none   ·   presenter = full - observers
//
//   node bench/overhead/measure.mjs [url] [seconds]
//
// Requires the bench-app running (default http://localhost:4312). Alternates the order of the two
// conditions across repeats so warm-up/JIT drift cannot systematically favour either one.

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:4312';
const WINDOW_S = Number(process.argv[3] ?? 8);
const REPEATS = 3;
const BUDGET_PCT = 3;

/**
 * Which fixture is under test. The enterprise view boots itself from its query param and the hostile
 * one is reached by a nav click, so the harness has to know which page it is supposed to end up on —
 * and has to ASSERT it got there, because measuring the wrong view reports a flatteringly small
 * number that looks entirely plausible.
 */
const ENTERPRISE = BASE.includes('enterprise');
const ANCHOR_TESTID = ENTERPRISE
  ? '[data-testid="enterprise-grid"]'
  : '[data-testid="hostile-ticker"]';

const metric = (metrics, name) => metrics.find((m) => m.name === name)?.value ?? 0;

/** The three conditions, as URL suffixes. */
/**
 * Condition flags, appended to BASE. Appended rather than replaced so a fixture's own query params
 * (e.g. ?enterprise=1) survive — replacing them is how the first enterprise run silently measured
 * the small fixture instead.
 */
const CONDITION = { full: '', observers: 'nopresent', none: 'no-hud' };

function urlFor(condition) {
  const flag = CONDITION[condition];
  if (flag === '') return BASE;
  return BASE.includes('?') ? `${BASE}&${flag}` : `${BASE}/?${flag}`;
}

/** Drive one condition and return the main-thread task-seconds consumed during the window. */
async function measureOnce(browser, condition) {
  const page = await browser.newPage();
  const url = urlFor(condition);
  await page.goto(url, { waitUntil: 'load' });

  // Sign in — by CLICK, so it works with the SDK disabled.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Sign in'),
    );
    btn?.click();
  });
  await page.waitForTimeout(500);
  // The enterprise fixture boots straight into its own view; the hostile one needs a nav click.
  // Navigating anyway would have silently measured the WRONG page — the first enterprise-scale run
  // returned numbers identical to the small fixture because it clicked away to Hostile.
  if (!ENTERPRISE) {
    await page.evaluate(() => {
      const nav = [...document.querySelectorAll('button,a')].find((b) =>
        b.textContent?.trim().startsWith('Hostile'),
      );
      nav?.click();
    });
  }
  // Confirm we are actually on the churning page — a silent miss would measure an idle page and
  // report a flatteringly small overhead.
  await page.waitForSelector(ANCHOR_TESTID, { timeout: 8000 });
  await page.waitForTimeout(1000); // let the churn reach steady state before sampling

  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  const before = (await client.send('Performance.getMetrics')).metrics;
  const t0 = Date.now();
  await page.waitForTimeout(WINDOW_S * 1000);
  const after = (await client.send('Performance.getMetrics')).metrics;
  const wallS = (Date.now() - t0) / 1000;

  const taskS = metric(after, 'TaskDuration') - metric(before, 'TaskDuration');
  await page.close();
  return { taskS, wallS };
}

const NAMES = ['full', 'observers', 'none'];

const browser = await chromium.launch({ headless: true });
const samples = [];
for (let i = 0; i < REPEATS; i++) {
  // Rotate the order so warm-up/JIT drift cannot systematically favour any one condition.
  const order = NAMES.map((_n, j) => NAMES[(j + i) % NAMES.length]);
  const run = {};
  for (const condition of order) run[condition] = await measureOnce(browser, condition);
  samples.push(run);
  console.log(
    `  repeat ${String(i + 1)}: ` +
      NAMES.map((n) => `${n} ${run[n].taskS.toFixed(3)}s`).join(' / ') +
      ' main-thread task time',
  );
}
await browser.close();

const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const taskOf = (n) => avg(samples.map((r) => r[n].taskS));
const fullS = taskOf('full');
const observersS = taskOf('observers');
const noneS = taskOf('none');
const wallS = avg(samples.map((r) => r.full.wallS));
// The budget is about instrumentation, so it is measured against the no-HUD condition.
const overheadPct = ((observersS - noneS) / wallS) * 100;
const presenterPct = ((fullS - observersS) / wallS) * 100;

// The method's own resolution: how much the SAME condition varies run to run. An overhead smaller than
// this is not a measurement of the SDK, it is noise — and reporting it as a number (especially a
// flattering negative one) would be exactly the self-corrupting perf claim this bench exists to prevent.
const spread = (xs) => ((Math.max(...xs) - Math.min(...xs)) / wallS) * 100;
const noiseFloorPct = Math.max(...NAMES.map((n) => spread(samples.map((r) => r[n].taskS))));
const resolved = Math.abs(overheadPct) > noiseFloorPct;

const busy = (t) => `${t.toFixed(3)}s  (${((t / wallS) * 100).toFixed(1)}% busy)`;
console.log('\n=== SDK overhead on the hostile fixture ===\n');
console.log(`  window                  : ${wallS.toFixed(1)}s x ${String(REPEATS)} repeats`);
console.log(`  full (observers + HUD)  : ${busy(fullS)}`);
console.log(`  observers only (no HUD) : ${busy(observersS)}`);
console.log(`  Reticle absent          : ${busy(noneS)}`);
console.log(
  `  presenter HUD costs     : ${presenterPct >= 0 ? '+' : ''}${presenterPct.toFixed(2)} pp  (opt out with present:false)`,
);
console.log(
  `  measured difference     : ${overheadPct >= 0 ? '+' : ''}${overheadPct.toFixed(2)} pp of main thread`,
);
console.log(
  `  method noise floor      : ±${noiseFloorPct.toFixed(2)} pp (same-condition run-to-run spread)`,
);
if (resolved) {
  console.log(`  instrumentation overhead: ${overheadPct.toFixed(2)} pp — resolved above noise`);
} else {
  console.log(
    `  instrumentation overhead: NOT RESOLVABLE — below this method's noise floor.\n` +
      `                            Report as "< ${noiseFloorPct.toFixed(1)}pp", never as the raw signed number.`,
  );
}
const pass = overheadPct < BUDGET_PCT; // an unresolvable difference is, by construction, under budget
console.log(`  budget                  : < ${String(BUDGET_PCT)}%  →  ${pass ? 'PASS' : 'FAIL'}\n`);

process.exit(pass ? 0 : 1);
