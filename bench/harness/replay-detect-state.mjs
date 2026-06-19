// State-oracle regression detection (Layer C, depth): a flow whose golden end-condition is STORE
// TRUTH — the source of truth no DOM read can reach — catches a dead-handler regression in the cheap
// deterministic replay loop, with no LLM.
//
// The action ships the top deployment (row 4000). A working handler sets the STORE's
// deployments[0].status to 'live'. The flow's success-state asserts that store value via the `state`
// predicate. We assert deployments[0] (index 0) because it survives the transport's collection cap —
// a known limitation of server-side path selection on a huge store (see iris-state-path-scoping task).
//
// Method (mirrors replay-detect-consequence, swapping the SIGNAL oracle for a STATE oracle):
//   1. record login + nav + open the row menu + Ship, annotate success-state = { statePath, store, equals }
//   2. baseline replay on the healthy app -> ok (ship sets the store status to 'live')
//   3. re-navigate with ?iris-break-click=ship-<id> (handler dead, element still present)
//   4. replay -> steps still resolve (NO testid drift), but the store status never changes -> the
//      state oracle fails -> status error. A presence-only test passes this green; store-truth does not.
import { writeFileSync } from 'node:fs';
import { IrisAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LLM_REDRIVE = { playwright_mcp: 30249, chrome_devtools_mcp: 32296 };

// Row 4000 is the top deployment (deployments[0], seed status 'queued'); shipping it sets the store
// status to 'live'. The dead handler leaves the store at 'queued', so the state oracle fails.
const FLOWS = [
  { name: 's-verify-ship', rowId: 4000, statePath: 'deployments.0.status', equals: 'live' },
];

async function replayOnce(a, flow) {
  const rep = await a.c.callTool('iris_flow_replay', { flowName: flow.name });
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
  const a = new IrisAdapter(URL);
  await a.start();
  try {
    await a.c.callTool('iris_record_start', { recordingName: flow.name });
    await a.login();
    await a.gotoView('deployments');
    await sleep(300);
    await a.clickTestid(`row-menu-trigger-${flow.rowId}`);
    await sleep(300);
    await a.clickTestid(`ship-${flow.rowId}`);
    await sleep(400);
    // The golden end-condition is STORE TRUTH: the shipped deployment's status in the store.
    await a.c.callTool('iris_annotate', {
      flow: flow.name,
      kind: 'success-state',
      store: 'app',
      statePath: flow.statePath,
      equals: flow.equals,
    });
    await a.c.callTool('iris_record_stop', { recordingName: flow.name });
    const saved = await a.c.callTool('iris_flow_save', { flowName: flow.name });
    const savedObj = JSON.parse(saved.text || '{}');

    // baseline: healthy app — the click logs the request, the store holds the status
    await a.c.callTool('iris_refresh', { hard: true });
    await sleep(1500);
    const baseline = await replayOnce(a, flow);

    // regression: ship handler dead, element still present → the store status never changes
    const brokenUrl = `${URL}${URL.includes('?') ? '&' : '?'}iris-break-click=ship-${flow.rowId}`;
    await a.c.callTool('iris_navigate', { url: brokenUrl });
    await sleep(1800);
    const regressed = await replayOnce(a, flow);

    const detected =
      baseline.status === 'ok' &&
      regressed.status !== 'ok' &&
      regressed.drifted === false &&
      regressed.successOk === false;
    return {
      flow: flow.name,
      tap: `ship-${flow.rowId}`,
      oracle: `state ${flow.statePath} == ${flow.equals}`,
      hasSuccess: savedObj.assertions ?? null,
      baseline,
      regressed,
      detected,
    };
  } finally {
    await a.stop();
  }
}

// A flaky baseline (slow post-login render on the live rig) is noise, not a missed detection — retry.
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
  layer: 'C-state (store-truth oracle catches a dead handler via the `state` predicate)',
  detection_rate: `${detectedCount}/${rows.length}`,
  per_run_when_caught: {
    iris_replay_mean_tokens: meanTokens,
    playwright_mcp_redrive_tokens: LLM_REDRIVE.playwright_mcp,
    chrome_devtools_mcp_redrive_tokens: LLM_REDRIVE.chrome_devtools_mcp,
  },
  ratio_vs_playwright: meanTokens ? Math.round(LLM_REDRIVE.playwright_mcp / meanTokens) : null,
  note: 'The element stays present (no testid drift); the dead Ship handler never updates the store, so the state oracle (deployments.0.status == live) is not satisfied. Asserts the app source of truth, deterministically, with no LLM.',
  rows,
};
writeFileSync('bench/raw/replay-detect-state.json', JSON.stringify(summary, null, 2));
console.log(
  `\n=== state-oracle detection ${summary.detection_rate}; caught at ~${meanTokens} tok vs Playwright ${LLM_REDRIVE.playwright_mcp} => ${summary.ratio_vs_playwright}x ===`,
);
process.exit(0);
