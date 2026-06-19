// Forbidden-call regression (Layer C): the NEGATIVE half of network cardinality — "must NOT call X".
//
// The mirror of the double-submit bench. Some endpoints must NEVER be hit on a given action: a legacy
// API you migrated off, an analytics/telemetry beacon on a privacy-sensitive screen, an N+1 fan-out a
// refactor reintroduces. Nothing visible changes — the request just goes out. The forbidden-call
// regression (`?iris-bug=forbidden-call`) makes the Compose action POST to `/api/legacy-telemetry`.
//
// Iris expresses the rule as a flow success consequence `net { urlContains, count: 0 }` ("this matcher
// must fire exactly zero times since the action"). On replay the oracle counts matching requests after
// the page settles: clean = 0 (ok), bugged = 1 (the oracle fails), with NO testid drift. The count read
// is post-settle (the same gate net.count uses), so a wait-until-true check can't pass at the instant
// before the forbidden call fires.
//
// Honest scope: Playwright/DevTools can observe requests, so raw counting is parity; the win is the same
// as the rest of the consequence family — a DECLARED, deterministic replay rule, no LLM re-drive.
import { writeFileSync } from 'node:fs';
import { IrisAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const LLM_REDRIVE = 30249; // Playwright MCP per-run re-drive (Layer B)
const FLOW = 'forbidden-compose';
const NET = { urlContains: '/api/legacy-telemetry', count: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (t) => {
  try {
    return JSON.parse(t || '{}');
  } catch {
    return {};
  }
};

async function replayOnce(a) {
  const rep = await a.c.callTool('iris_flow_replay', { flowName: FLOW });
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

const a = new IrisAdapter(URL);
await a.start();
let result;
try {
  // Record: login → Compose → type a prompt → Generate. Declare the "must never call" consequence.
  await a.c.callTool('iris_record_start', { recordingName: FLOW });
  await a.login();
  await a.gotoView('compose');
  await sleep(300);
  const prompt = await a._refByTestid('compose-prompt');
  if (prompt.ref) {
    await a.c.callTool('iris_act', {
      ref: prompt.ref,
      action: 'fill',
      args: { value: 'ship the new pricing page' },
    });
  }
  await a.clickTestid('compose-generate');
  await sleep(1200);
  const ann = await a.c.callTool('iris_annotate', { flow: FLOW, kind: 'success-state', net: NET });
  await a.c.callTool('iris_record_stop', { recordingName: FLOW });
  await a.c.callTool('iris_flow_save', { flowName: FLOW });

  // Baseline: healthy app — the forbidden endpoint is never called → the count:0 oracle holds.
  await a.c.callTool('iris_refresh', { hard: true });
  await sleep(1500);
  const baseline = await replayOnce(a);

  // Regression: forbidden-call injected — the action POSTs to the forbidden endpoint → the oracle fails.
  const buggedUrl = `${URL}${URL.includes('?') ? '&' : '?'}iris-bug=forbidden-call`;
  await a.c.callTool('iris_navigate', { url: buggedUrl });
  await sleep(1800);
  const regressed = await replayOnce(a);

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
    'Forbidden-call regression (Layer C) — a net.count:0 consequence catches a must-never-fire call',
  scenario: 'Compose POSTs to a forbidden endpoint it must never hit (?iris-bug=forbidden-call)',
  oracle: 'flow.success net { urlContains:/api/legacy-telemetry, count:0 }',
  ...result,
  per_run_tokens: result.regressed?.tokens ?? null,
  ratio_vs_playwright_redrive: result.regressed?.tokens
    ? Math.round(LLM_REDRIVE / result.regressed.tokens)
    : null,
  competitor_position:
    'Playwright/DevTools can observe requests, so raw counting is parity — but only Iris replays "must never call X" as a declared, deterministic consequence with no LLM re-drive, read post-settle so it cannot pass before the call fires.',
  honest_verdict: result.detected
    ? `Forbidden-call CAUGHT: clean replay holds (0 calls), bugged replay fails the count:0 oracle (1 call) with no testid drift — caught deterministically at ~${result.regressed.tokens} tok/run.`
    : 'NOT DETECTED — investigate the injector or the net.count:0 oracle before claiming the catch.',
};
writeFileSync('bench/raw/forbidden-call-bench.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  `\n=== forbidden-call: ${result.detected ? 'CAUGHT' : 'MISSED'} | clean successOk=${result.baseline?.successOk} bugged successOk=${result.regressed?.successOk} drift=${result.regressed?.drifted} | ~${result.regressed?.tokens} tok/run ===`,
);
process.exit(result.detected ? 0 : 1);
