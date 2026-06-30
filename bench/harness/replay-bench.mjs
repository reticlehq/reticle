// Regression-replay benchmark (Layer C): the honest home of the 70x+ token claim.
//
// Regression testing = the SAME verification run repeatedly. Reticle records a flow once, then
// reticle_flow_replay re-runs it DETERMINISTICALLY (no LLM) against the live DOM, re-resolving each
// semantic anchor and asserting the consequence — returning a compact { status, steps } verdict.
// Playwright MCP / Chrome DevTools MCP have no replay: an agent must re-drive the whole flow with
// the LLM EVERY run (~30k / ~32k tokens, measured in Layer B).
//
// This harness records each verify flow once, replays it, and measures the per-regression-run cost
// (the verdict the agent/CI reads — deterministic, no model). Authoring cost (the one-time LLM
// record) is NOT a per-run cost and is excluded, by design — that's the whole point of regression.
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Per-run LLM re-drive cost for the tools with no replay (from Layer B, agent-loop-openai.json).
const LLM_REDRIVE = { playwright_mcp: 30249, chrome_devtools_mcp: 32296 };

// Each flow: login + the verify steps (self-contained, so replay re-runs end to end).
const FLOWS = [
  { name: 'verify-500', steps: [{ view: 'diagnostics' }, { tap: 'fault-500' }] },
  { name: 'verify-console', steps: [{ view: 'diagnostics' }, { tap: 'fault-buggy' }] },
  { name: 'verify-route', steps: [{ view: 'compose' }] },
  { name: 'verify-modal', steps: [{ view: 'deployments' }, { tap: 'new-deploy' }] },
];

async function recordAndReplay(flow) {
  const a = new ReticleAdapter(URL);
  await a.start();
  try {
    await a.c.callTool('reticle_record_start', { recordingName: flow.name });
    await a.login();
    for (const s of flow.steps) {
      if (s.view) await a.gotoView(s.view);
      else if (s.tap) await a.clickTestid(s.tap);
      await sleep(200);
    }
    await a.c.callTool('reticle_record_stop', { recordingName: flow.name });
    const saved = await a.c.callTool('reticle_flow_save', { flowName: flow.name });
    const savedObj = JSON.parse(saved.text || '{}');
    // reset to a fresh load so replay re-runs the whole flow (incl. login) from the top
    await a.c.callTool('reticle_refresh', { hard: true });
    await sleep(1500);
    const rep = await a.c.callTool('reticle_flow_replay', { flowName: flow.name });
    const repObj = JSON.parse(rep.text || '{}');
    const m = measure(rep.text || '');
    const drifted = Array.isArray(repObj.steps)
      ? repObj.steps.find((s) => s && s.drift)
      : undefined;
    return {
      flow: flow.name,
      stepCount: savedObj.stepCount ?? null,
      replay_status: repObj.status ?? 'unknown',
      replay_tokens: m.tokens_o200k,
      replay_chars: m.chars,
      drift_anchor: drifted?.drift?.anchor ?? null,
      drift_nearest: drifted?.drift?.nearest ?? null,
    };
  } finally {
    await a.stop();
  }
}

const rows = [];
for (const flow of FLOWS) {
  try {
    const r = await recordAndReplay(flow);
    rows.push(r);
    console.log(JSON.stringify(r));
  } catch (e) {
    rows.push({ flow: flow.name, error: String(e).slice(0, 200) });
    console.log(JSON.stringify({ flow: flow.name, error: String(e).slice(0, 120) }));
  }
}

const measured = rows.filter((r) => typeof r.replay_tokens === 'number');
const meanReplay = measured.length
  ? Math.round(measured.reduce((n, r) => n + r.replay_tokens, 0) / measured.length)
  : null;
const summary = {
  layer: 'C (regression replay — deterministic, no LLM)',
  per_run: {
    reticle_replay_mean_tokens: meanReplay,
    playwright_mcp_redrive_tokens: LLM_REDRIVE.playwright_mcp,
    chrome_devtools_mcp_redrive_tokens: LLM_REDRIVE.chrome_devtools_mcp,
  },
  ratio_vs_playwright: meanReplay ? Math.round(LLM_REDRIVE.playwright_mcp / meanReplay) : null,
  note: 'Reticle replay is deterministic (no model). Competitors have no replay — an agent re-drives every run at the Layer B cost. Ratio compounds: over N runs Reticle pays ~author-once + N*replay; competitors pay N*re-drive.',
  rows,
};
writeFileSync('bench/raw/replay-bench.json', JSON.stringify(summary, null, 2));
console.log(
  '\n=== per-regression-run: Reticle replay ~' +
    meanReplay +
    ' tok vs Playwright ' +
    LLM_REDRIVE.playwright_mcp +
    ' => ' +
    summary.ratio_vs_playwright +
    'x ===',
);
process.exit(0);
