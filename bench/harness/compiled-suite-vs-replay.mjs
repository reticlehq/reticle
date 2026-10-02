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
import { suiteSteps } from './suite-flows.mjs';
import { measure } from './tokenizer.mjs';
import { pathToFileURL } from 'node:url';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sel = (t) => `[data-testid="${t}"]`;
const FLOWS = suiteSteps();

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
    // What an agent pays to READ the result. Neither side calls a model, so this is the only token
    // cost either one has, and a pass that recorded none was rejected as having measured nothing.
    report_tokens: measure(report).tokens_o200k,
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
    report_tokens: measure(text).tokens_o200k,
  };
}

/**
 * The finding, DERIVED — never a paragraph written in advance.
 *
 * It used to be fixed text asserting, among other things, that "on wall-time the compiled script is
 * faster end-to-end". That sentence shipped in the artifact whatever the run measured, which makes
 * the harness a place to publish a conclusion rather than a place to test one. A benchmark that
 * states its answer before running is not evidence, and it is the same failure the false-green work
 * in this release is about: a report that cannot be wrong.
 */
export function finding(pw, rt, flows = FLOWS.length) {
  const tokensEqual = 0 === pw.llm_tokens && 0 === rt.llm_tokens;
  const faster = pw.end_to_end_ms <= rt.end_to_end_ms ? 'the compiled script' : 'replay';
  const ratio = (
    Math.max(pw.end_to_end_ms, rt.end_to_end_ms) /
    Math.max(1, Math.min(pw.end_to_end_ms, rt.end_to_end_ms))
  ).toFixed(1);
  const callFaster = rt.verify_call_ms <= pw.end_to_end_ms ? 'under' : 'over';
  return [
    tokensEqual
      ? 'Both cost ZERO LLM tokens, so the token-efficiency argument does not apply to a compiled ' +
        'suite at all — it applies to an agent re-driving the browser.'
      : `LLM tokens were NOT zero on both sides (playwright ${pw.llm_tokens}, replay ` +
        `${rt.llm_tokens}); this run is not the comparison this harness claims to make.`,
    `Verdicts: playwright ${pw.passed}/${flows}, replay ${rt.passed}/${flows}.`,
    `End to end, ${faster} was faster this run (${pw.end_to_end_ms}ms vs ${rt.end_to_end_ms}ms, ` +
      `${ratio}x); replay's verify call alone was ${rt.verify_call_ms}ms, ${callFaster} the ` +
      "compiled script's whole run, and the rest is browser+SDK handshake the adapter pads.",
    'What is NOT derivable from these numbers, and is the actual difference: what each check can ' +
      'see. Replay expectations cover signal, state, network cardinality and console, which a DOM ' +
      'assertion cannot reach, and the flow was recorded by driving rather than hand-written.',
  ].join(' ');
}

/*
 * Only when RUN, so the module can also be imported.
 *
 * Top-level await made importing this file execute the whole benchmark, which is why the derived
 * verdict below had no test: there was no way to reach it without launching two browsers.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const pw = await compiledPlaywright();
  const rt = await reticleReplay();
  const out = {
    question: 'For a company that ALREADY has Playwright scripts, what does Reticle replay cost?',
    flows: FLOWS.length,
    playwright: pw,
    reticle: rt,
    finding: finding(pw, rt, FLOWS.length),
  };
  writeFileSync('bench/raw/compiled-suite-vs-replay.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
