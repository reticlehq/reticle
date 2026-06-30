// Network-cardinality regression (Layer C): the double-submit class a presence check cannot see.
//
// The Compose action is supposed to fire EXACTLY ONE `POST /api/generate-script`. The double-submit
// bug (`?reticle-bug=double-submit`) fires it twice — the classic useEffect-double-fire / missing-guard /
// retry-storm regression. The damage is real (a duplicate order, a double charge, two deploys) but the
// UI is identical: one result renders. A presence assertion ("a POST fired") PASSES on both the clean
// and the bugged app — the request did fire. Only a CARDINALITY assertion catches it.
//
// Reticle expresses that as a flow success consequence `net: { method, urlContains, count: 1 }` (set via
// reticle_annotate success-state). On replay the success oracle counts the matching requests since the
// action: clean = 1 (ok), bugged = 2 (the oracle fails — flow.success not satisfied), with NO testid
// drift (the button is present and clicks fine). Caught deterministically in the cheap replay loop.
//
// Honest scope: Playwright CAN count requests via route handlers, and DevTools CAN read the network
// panel — raw request observation is parity. The win here is that the count is a DECLARED, replayable
// consequence: caught in deterministic replay (no LLM re-drive) and tied to the action, the same fused
// moat as the state oracle. This harness measures the catch + its per-run token cost.
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const LLM_REDRIVE = 30249; // Playwright MCP per-run re-drive (Layer B)
const FLOW = 'card-compose';
const NET = { method: 'POST', urlContains: '/api/generate-script', count: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (t) => {
  try {
    return JSON.parse(t || '{}');
  } catch {
    return {};
  }
};

// One replay → the verdict an agent/CI reads (status + whether the success oracle held + drift + cost).
async function replayOnce(a) {
  const rep = await a.c.callTool('reticle_flow_replay', { flowName: FLOW });
  const obj = parse(rep.text);
  const successRow = Array.isArray(obj.steps)
    ? obj.steps.find((s) => s && s.tool === 'success')
    : undefined;
  const drifted = Array.isArray(obj.steps) ? obj.steps.some((s) => s && s.drift) : false;
  return {
    status: obj.status ?? 'unknown',
    successOk: successRow?.ok ?? null,
    drifted,
    tokens: measure(rep.text || '').tokens_o200k,
  };
}

const a = new ReticleAdapter(URL);
await a.start();
let result;
try {
  // Record: login → Compose → type a prompt → Generate. Then declare the cardinality consequence.
  await a.c.callTool('reticle_record_start', { recordingName: FLOW });
  await a.login();
  await a.gotoView('compose');
  await sleep(300);
  const prompt = await a._refByTestid('compose-prompt');
  if (prompt.ref) {
    await a.c.callTool('reticle_act', {
      ref: prompt.ref,
      action: 'fill',
      args: { value: 'shipped faster builds and a new dashboard' },
    });
  }
  await a.clickTestid('compose-generate');
  await sleep(1200); // let the POST complete + the result render
  const ann = await a.c.callTool('reticle_annotate', {
    flow: FLOW,
    kind: 'success-state',
    net: NET,
  });
  await a.c.callTool('reticle_record_stop', { recordingName: FLOW });
  await a.c.callTool('reticle_flow_save', { flowName: FLOW });

  // Baseline: healthy app — exactly one POST → the count:1 oracle holds.
  await a.c.callTool('reticle_refresh', { hard: true });
  await sleep(1500);
  const baseline = await replayOnce(a);

  // Regression: the same flow, double-submit injected — two POSTs → the count:1 oracle fails.
  const buggedUrl = `${URL}${URL.includes('?') ? '&' : '?'}reticle-bug=double-submit`;
  await a.c.callTool('reticle_navigate', { url: buggedUrl });
  await sleep(1800);
  const regressed = await replayOnce(a);

  // Caught when: baseline holds; the regression does NOT (status not ok + oracle failed) WITHOUT any
  // testid drift — proving the catch came from the request COUNT, not from a missing element.
  const detected =
    baseline.status === 'ok' &&
    baseline.successOk === true &&
    regressed.status !== 'ok' &&
    regressed.successOk === false &&
    regressed.drifted === false;
  result = {
    annotate_compiled: parse(ann.text).compiled ?? null,
    baseline,
    regressed,
    detected,
  };
} finally {
  await a.stop();
}

const summary = {
  dimension:
    'Network-cardinality regression (Layer C) — double-submit caught by a net.count consequence',
  scenario:
    'Compose fires POST /api/generate-script; the bug fires it twice (?reticle-bug=double-submit)',
  oracle: 'flow.success net { method:POST, urlContains:/api/generate-script, count:1 }',
  ...result,
  per_run_tokens: result.regressed?.tokens ?? null,
  ratio_vs_playwright_redrive: result.regressed?.tokens
    ? Math.round(LLM_REDRIVE / result.regressed.tokens)
    : null,
  competitor_position:
    'Playwright/DevTools can observe requests, so raw counting is parity — but only Reticle replays the count as a declared consequence with no LLM re-drive. Presence-only assertions ("a POST fired") pass the double-submit; the cardinality is the catch.',
  honest_verdict: result.detected
    ? `Double-submit CAUGHT: clean replay holds (1 POST), bugged replay fails the count:1 oracle (2 POSTs) with no testid drift — caught deterministically at ~${result.regressed.tokens} tok/run.`
    : 'NOT DETECTED — investigate the injector ordering or the net.count oracle before claiming the catch.',
};
writeFileSync('bench/raw/network-cardinality-bench.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  `\n=== network-cardinality: double-submit ${result.detected ? 'CAUGHT' : 'MISSED'} | clean successOk=${result.baseline?.successOk} bugged successOk=${result.regressed?.successOk} drift=${result.regressed?.drifted} | ~${result.regressed?.tokens} tok/run ===`,
);
process.exit(result.detected ? 0 : 1);
