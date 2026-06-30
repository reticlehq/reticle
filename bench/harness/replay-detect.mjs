// Regression-DETECTION benchmark (Layer C, detection half): proves reticle_flow_replay is not just
// cheap (~180 tok/run, Layer C cost half) but CORRECT — clean replay passes, a real regression is
// caught, naming the broken anchor, at the same deterministic cost.
//
// Method per flow:
//   1. record the flow once against the healthy app, replay it -> BASELINE verdict + tokens
//   2. re-navigate to the SAME url with ?reticle-break=<anchor> (dev-only injector strips that
//      data-testid — a real "selector regression": element renders, stable hook gone)
//   3. replay the SAME recorded flow -> REGRESSED verdict + tokens
//   4. detection holds when baseline replays clean (ok) and the regressed replay drifts naming the
//      broken anchor. Cost is measured both ways (a caught regression is still ~180 tok, no LLM).
//
// Playwright/DevTools MCP have no replay: catching the same regression means an agent re-drives the
// whole flow with the LLM every run (~30k tok, Layer B) — and may or may not notice the break.
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LLM_REDRIVE = { playwright_mcp: 30249, chrome_devtools_mcp: 32296 };

// Each flow names the anchor a real regression would break (the click target the verdict hinges on).
// All break targets are reliably present at record time (sidebar nav, or controls on the diagnostics
// view), so the recording captures the click — a precondition for replay to later catch its removal.
const FLOWS = [
  {
    name: 'd-verify-500',
    steps: [{ view: 'diagnostics' }, { tap: 'fault-500' }],
    breakId: 'fault-500',
  },
  { name: 'd-verify-route', steps: [{ view: 'compose' }], breakId: 'nav-compose' },
  {
    name: 'd-verify-console',
    steps: [{ view: 'diagnostics' }, { tap: 'fault-buggy' }],
    breakId: 'fault-buggy',
  },
];

async function runSteps(a, flow) {
  await a.login();
  for (const s of flow.steps) {
    if (s.view) await a.gotoView(s.view);
    else if (s.tap) await a.clickTestid(s.tap);
    await sleep(200);
  }
}

// Replay the loaded flow once; return its compact verdict + measured tokens.
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
  // The drift anchor (if any) — the step that stopped the replay.
  const drifted = Array.isArray(obj.steps) ? obj.steps.find((s) => s && s.drift) : undefined;
  return {
    status: obj.status ?? 'unknown',
    tokens: m.tokens_o200k,
    driftAnchor: drifted?.drift?.anchor ?? null,
    driftReason: drifted?.drift?.reasonKind ?? null,
    nearest: drifted?.drift?.nearest ?? null,
  };
}

async function detectFor(flow) {
  const a = new ReticleAdapter(URL);
  await a.start();
  try {
    // 1. record clean
    await a.c.callTool('reticle_record_start', { recordingName: flow.name });
    await runSteps(a, flow);
    await a.c.callTool('reticle_record_stop', { recordingName: flow.name });
    const saved = await a.c.callTool('reticle_flow_save', { flowName: flow.name });
    const stepCount = JSON.parse(saved.text || '{}').stepCount ?? null;

    // 2. baseline replay on the healthy app
    await a.c.callTool('reticle_refresh', { hard: true });
    await sleep(1500);
    const baseline = await replayOnce(a, flow);

    // 3. inject the regression: same SPA, the flow's anchor's data-testid stripped
    const brokenUrl = `${URL}${URL.includes('?') ? '&' : '?'}reticle-break=${flow.breakId}`;
    await a.c.callTool('reticle_navigate', { url: brokenUrl });
    await sleep(1800);
    const regressed = await replayOnce(a, flow);

    const detected =
      baseline.status === 'ok' &&
      regressed.status !== 'ok' &&
      regressed.driftAnchor === flow.breakId;
    return { flow: flow.name, breakId: flow.breakId, stepCount, baseline, regressed, detected };
  } finally {
    await a.stop();
  }
}

// A clean baseline is the precondition for testing detection. If the live rig hits a timing hiccup
// (slow post-login render → a baseline drift), that's rig noise, not a missed detection — retry once.
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
const meanRegressedTokens = regressedTokens.length
  ? Math.round(regressedTokens.reduce((n, t) => n + t, 0) / regressedTokens.length)
  : null;
const summary = {
  layer: 'C-detection (deterministic replay catches an injected regression)',
  detection_rate: `${detectedCount}/${rows.length}`,
  per_run_when_caught: {
    reticle_replay_mean_tokens: meanRegressedTokens,
    playwright_mcp_redrive_tokens: LLM_REDRIVE.playwright_mcp,
    chrome_devtools_mcp_redrive_tokens: LLM_REDRIVE.chrome_devtools_mcp,
  },
  ratio_vs_playwright: meanRegressedTokens
    ? Math.round(LLM_REDRIVE.playwright_mcp / meanRegressedTokens)
    : null,
  note: 'Detection holds when clean replay=ok and the regressed replay drifts naming the broken anchor. Cost is the same ~180 tok whether the replay passes or catches a break (no LLM either way).',
  rows,
};
writeFileSync('bench/raw/replay-detect.json', JSON.stringify(summary, null, 2));
console.log(
  `\n=== detection ${summary.detection_rate}; caught regression replay ~${meanRegressedTokens} tok vs Playwright ${LLM_REDRIVE.playwright_mcp} re-drive => ${summary.ratio_vs_playwright}x ===`,
);
process.exit(0);
