// Consequence-regression detection (Layer C, depth): the regression a presence-only test — and a
// self-healed locator — passes GREEN, and only a flow with a real consequence oracle catches.
//
// A refactor leaves the button rendered but its onClick dead (rewired, or throws before its effect).
// The element is present, a locator resolves, the click step "succeeds" — yet the feature does
// nothing. Selector-drift detection (replay-detect.mjs) sees no drift and would pass. Reticle flows
// carry a success oracle (assert-signal / success-state) — a real CONSEQUENCE the locator cannot
// fake — so replay catches it.
//
// Method per flow:
//   1. record login + the action, annotate success-state = the action's consequence signal
//   2. baseline replay on the healthy app -> status ok (steps resolve AND the signal fires)
//   3. re-navigate with ?reticle-break-click=<testid> (handler dead, element still present)
//   4. replay -> steps still resolve (NO testid drift), but the success oracle is NOT satisfied ->
//      status error ("flow.success not satisfied"). That is the green-but-wrong catch.
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LLM_REDRIVE = { playwright_mcp: 30249, chrome_devtools_mcp: 32296 };
const FAULT_INJECTED = 'fault:injected'; // the demo's consequence signal for a fault click

// Each flow's action emits FAULT_INJECTED on success; breaking the click kills that consequence.
const FLOWS = [
  { name: 'c-verify-500', tap: 'fault-500' },
  { name: 'c-verify-404', tap: 'fault-404' },
];

async function replayOnce(a, flow) {
  const rep = await a.c.callTool('reticle_flow_replay', { flowName: flow.name });
  const text = rep.text || '';
  let obj = {};
  try {
    obj = JSON.parse(text);
  } catch {
    /* leave empty */
  }
  const m = measure(text);
  const drifted = Array.isArray(obj.steps) ? obj.steps.find((s) => s && s.drift) : undefined;
  const successRow = Array.isArray(obj.steps)
    ? obj.steps.find((s) => s && s.tool === 'success')
    : undefined;
  return {
    status: obj.status ?? 'unknown',
    tokens: m.tokens_o200k,
    drifted: drifted !== undefined,
    successOk: successRow?.ok ?? null,
  };
}

async function detectFor(flow) {
  const a = new ReticleAdapter(URL);
  await a.start();
  try {
    await a.c.callTool('reticle_record_start', { recordingName: flow.name });
    await a.login();
    await a.gotoView('diagnostics');
    await sleep(200);
    await a.clickTestid(flow.tap);
    await sleep(400);
    // The flow's golden end-condition is the CONSEQUENCE, not the button's presence.
    await a.c.callTool('reticle_annotate', {
      flow: flow.name,
      kind: 'success-state',
      signal: FAULT_INJECTED,
    });
    await a.c.callTool('reticle_record_stop', { recordingName: flow.name });
    const saved = await a.c.callTool('reticle_flow_save', { flowName: flow.name });
    const savedObj = JSON.parse(saved.text || '{}');

    // baseline: healthy app — steps resolve AND the consequence fires
    await a.c.callTool('reticle_refresh', { hard: true });
    await sleep(1500);
    const baseline = await replayOnce(a, flow);

    // regression: handler dead, element still present
    const brokenUrl = `${URL}${URL.includes('?') ? '&' : '?'}reticle-break-click=${flow.tap}`;
    await a.c.callTool('reticle_navigate', { url: brokenUrl });
    await sleep(1800);
    const regressed = await replayOnce(a, flow);

    // caught when: baseline ok; regressed NOT ok; regressed did NOT drift (element present) but the
    // success oracle failed — proving the catch came from the consequence, not from selector drift.
    const detected =
      baseline.status === 'ok' &&
      regressed.status !== 'ok' &&
      regressed.drifted === false &&
      regressed.successOk === false;
    return {
      flow: flow.name,
      tap: flow.tap,
      hasSuccess: savedObj.assertions ?? null,
      baseline,
      regressed,
      detected,
    };
  } finally {
    await a.stop();
  }
}

// A clean baseline is the precondition for testing detection; a flaky baseline (slow post-login
// render on the live rig) is noise, not a missed detection — retry once before counting it.
async function detectWithBaselineRetry(flow) {
  let r = await detectFor(flow);
  if (r.baseline && r.baseline.status !== 'ok') r = await detectFor(flow);
  return r;
}

const rows = [];
for (const flow of FLOWS) {
  try {
    const r = await detectWithBaselineRetry(flow);
    rows.push(r);
    console.log(JSON.stringify(r));
  } catch (e) {
    rows.push({ flow: flow.name, error: String(e).slice(0, 200) });
    console.log(JSON.stringify({ flow: flow.name, error: String(e).slice(0, 120) }));
  }
}

const detectedCount = rows.filter((r) => r.detected).length;
const regressedTokens = rows.filter((r) => r.regressed).map((r) => r.regressed.tokens);
const meanTokens = regressedTokens.length
  ? Math.round(regressedTokens.reduce((n, t) => n + t, 0) / regressedTokens.length)
  : null;
const summary = {
  layer: 'C-consequence (success oracle catches a dead handler — green-but-wrong)',
  detection_rate: `${detectedCount}/${rows.length}`,
  per_run_when_caught: {
    reticle_replay_mean_tokens: meanTokens,
    playwright_mcp_redrive_tokens: LLM_REDRIVE.playwright_mcp,
    chrome_devtools_mcp_redrive_tokens: LLM_REDRIVE.chrome_devtools_mcp,
  },
  ratio_vs_playwright: meanTokens ? Math.round(LLM_REDRIVE.playwright_mcp / meanTokens) : null,
  note: 'The element stays present (no testid drift); the click handler is dead so the consequence signal never fires and the success oracle fails. A presence-only test or a self-healed locator passes this green.',
  rows,
};
writeFileSync('bench/raw/replay-detect-consequence.json', JSON.stringify(summary, null, 2));
console.log(
  `\n=== consequence detection ${summary.detection_rate}; caught at ~${meanTokens} tok vs Playwright ${LLM_REDRIVE.playwright_mcp} => ${summary.ratio_vs_playwright}x ===`,
);
process.exit(0);
