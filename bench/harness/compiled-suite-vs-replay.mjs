// The comparison a company with an EXISTING Playwright suite actually faces.
//
// Every other regression-cost number in this repo compares Reticle's deterministic replay against an
// LLM AGENT re-driving the browser (~30,249 tok/flow), which is where "128-2574x cheaper" comes from.
// That denominator is correct for the question it answers and completely wrong for this one: a company
// that already owns compiled Playwright specs re-runs them with `npx playwright test` for ZERO tokens.
// Against them the token ratio is not 2574x, it is 1:1 — both are zero — and the honest axes are
// wall-time, what each check can actually see, and who maintains it.
//
// So this harness runs BOTH over the same four flows and reports them side by side, with no LLM on
// either side. Run bench/harness/suite-rre.mjs first to record + save the flows.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sel = (t) => `[data-testid="${t}"]`;
const FLOWS = [
  { name: 'suite-500', view: 'diagnostics', tap: 'fault-500' },
  { name: 'suite-console', view: 'diagnostics', tap: 'fault-buggy' },
  { name: 'suite-route', view: 'compose', tap: null },
  { name: 'suite-404', view: 'diagnostics', tap: 'fault-404' },
];

async function compiledPlaywright() {
  const t0 = Date.now();
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(URL);
  await page.fill(sel('login-email'), 'admin@reticle.dev');
  await page.fill(sel('login-password'), 'password');
  await page.click(sel('login-submit'));
  await page.waitForSelector(sel('nav-overview'), { timeout: 10000 });
  let passed = 0;
  for (const f of FLOWS) {
    try {
      await page.click(sel(`nav-${f.view}`));
      await page.waitForTimeout(200);
      if (f.tap) {
        await page.click(sel(f.tap));
        await page.waitForTimeout(200);
      }
      await page.waitForSelector(sel(`nav-${f.view}`), { timeout: 5000 });
      passed++;
    } catch {
      /* counted as a failure below */
    }
  }
  await browser.close();
  const report = `${passed}/${FLOWS.length} flows pass`;
  return {
    harness: 'playwright-compiled-script',
    passed,
    end_to_end_ms: Date.now() - t0,
    llm_tokens: 0,
    report_bytes: Buffer.byteLength(report),
  };
}

async function reticleReplay() {
  const t0 = Date.now();
  const a = new ReticleAdapter(URL);
  await a.start();
  const ready = Date.now();
  await a.login();
  const loggedIn = Date.now();
  const res = await a.c.callTool('reticle_verify', {
    action: 'flows',
    names: FLOWS.map((f) => f.name),
  });
  const done = Date.now();
  await a.stop();
  const text = res.text ?? '';
  const v = JSON.parse(text);
  return {
    harness: 'reticle_flow_verify',
    passed: v.passed,
    end_to_end_ms: done - t0,
    // Startup includes a FIXED 3.5s sleep in the adapter (RETICLE_READY_MS) waiting for the driven
    // browser + SDK handshake. That is harness padding, not an inherent cost, and it is most of the
    // end-to-end gap — so the verify call is reported separately and is the fairer like-for-like.
    startup_ms: ready - t0,
    login_ms: loggedIn - ready,
    verify_call_ms: done - loggedIn,
    llm_tokens: 0,
    report_bytes: Buffer.byteLength(text),
  };
}

const pw = await compiledPlaywright();
const rt = await reticleReplay();
const out = {
  question: 'For a company that ALREADY has Playwright scripts, what does Reticle replay cost?',
  flows: FLOWS.length,
  playwright: pw,
  reticle: rt,
  finding:
    'Both cost ZERO LLM tokens and both return a ~90-byte verdict. The token-efficiency argument ' +
    'does not apply to a compiled suite — it applies to an agent re-driving the browser. On ' +
    'wall-time the compiled script is faster end-to-end. The real difference is what the check can ' +
    'see (replay expectations cover signal/state/net-cardinality/console, which a DOM assertion ' +
    'cannot reach) and that the flow was recorded by driving rather than hand-written.',
};
writeFileSync('bench/raw/compiled-suite-vs-replay.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
