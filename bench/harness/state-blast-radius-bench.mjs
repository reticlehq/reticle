// State blast-radius regression (Layer C): an action mutates store state it has no business touching.
//
// This is the deepest in-source moat. The Compose action should only set compose.result. The
// mutation-leak regression (`?iris-bug=mutation-leak`) makes it ALSO corrupt an UNRELATED store path —
// the top deployment's status. Nothing visible changes (the Deployments view isn't even on screen), so
// a DOM/visual/a11y tool sees a perfect Compose. The only way to catch it is to assert that the
// unrelated store path STAYED PUT — a state invariant. No out-of-page tool can make that assertion at
// all; it requires the program's own state.
//
// Iris expresses it as a flow success consequence `state { path:'deployments.0.status', equals:<baseline> }`
// (the value read live before recording, so the invariant is "this did not move"). On replay: clean =
// holds (Compose never touches deployments), bugged = the leak flipped it → the invariant fails, with NO
// testid drift (the Compose button is present and clicks fine). Caught deterministically in cheap replay.
//
// Distinct from the state-ORACLE row: that asserts an INTENDED change happened (dead handler → it
// didn't); this asserts an UNINTENDED change did NOT happen (a side-effect leak → it did). Positive vs
// negative — two different regression classes, both invisible to a DOM tool.
import { writeFileSync } from 'node:fs';
import { IrisAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const LLM_REDRIVE = 30249; // Playwright MCP per-run re-drive (Layer B)
const FLOW = 'blast-radius-compose';
const INVARIANT_PATH = 'deployments.0.status';
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

async function composeGenerate(a) {
  await a.gotoView('compose');
  await sleep(300);
  const prompt = await a._refByTestid('compose-prompt');
  if (prompt.ref) {
    await a.c.callTool('iris_act', {
      ref: prompt.ref,
      action: 'fill',
      args: { value: 'shipped a faster build pipeline' },
    });
  }
  await a.clickTestid('compose-generate');
  await sleep(1200);
}

const a = new IrisAdapter(URL);
await a.start();
let result;
try {
  // Record login + Compose generate (login MUST be in the flow so replay re-auths after a hard refresh).
  await a.c.callTool('iris_record_start', { recordingName: FLOW });
  await a.login();
  await sleep(300);
  // Read the live baseline value of the path the Compose action must NOT touch (deterministic seed).
  // A bare read — not a recorded step.
  const baselineStatus = String(
    parse((await a.c.callTool('iris_state', { store: 'app', path: INVARIANT_PATH })).text).value ??
      '',
  );
  await composeGenerate(a);
  const ann = await a.c.callTool('iris_annotate', {
    flow: FLOW,
    kind: 'success-state',
    store: 'app',
    statePath: INVARIANT_PATH,
    equals: baselineStatus,
    hold: true,
  });
  await a.c.callTool('iris_record_stop', { recordingName: FLOW });
  await a.c.callTool('iris_flow_save', { flowName: FLOW });

  // Baseline: healthy app — Compose leaves deployments untouched → the invariant holds.
  await a.c.callTool('iris_refresh', { hard: true });
  await sleep(1500);
  const baseline = await replayOnce(a);

  // Regression: mutation-leak injected — Compose corrupts deployments.0.status → the invariant fails.
  const buggedUrl = `${URL}${URL.includes('?') ? '&' : '?'}iris-bug=mutation-leak`;
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
    baseline_status: baselineStatus,
    annotate_compiled: parse(ann.text).compiled ?? null,
    baseline,
    regressed,
    detected,
  };
} finally {
  await a.stop();
}

const summary = {
  dimension: 'State blast-radius regression (Layer C) — an action mutates unrelated store state',
  scenario: 'Compose corrupts the top deployment status as a side-effect (?iris-bug=mutation-leak)',
  oracle: `state ${INVARIANT_PATH} == "${result.baseline_status}" (invariant: Compose must not move it)`,
  ...result,
  per_run_tokens: result.regressed?.tokens ?? null,
  ratio_vs_playwright_redrive: result.regressed?.tokens
    ? Math.round(LLM_REDRIVE / result.regressed.tokens)
    : null,
  competitor_position:
    'No out-of-page tool can assert this: a DOM/visual/a11y tool sees a perfect Compose, and the corrupted store path is on a view that is not even rendered. The blast radius of an action lives in the program state Iris reads and competitors cannot.',
  honest_verdict: result.detected
    ? `Blast-radius CAUGHT: clean replay holds (${INVARIANT_PATH} unchanged), bugged replay fails the invariant (Compose corrupted it) with no testid drift — caught deterministically at ~${result.regressed.tokens} tok/run.`
    : 'NOT DETECTED — investigate the mutation-leak injector or the state invariant before claiming the catch.',
};
writeFileSync('bench/raw/state-blast-radius-bench.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  `\n=== state-blast-radius: ${result.detected ? 'CAUGHT' : 'MISSED'} | baseline=${result.baseline_status} clean successOk=${result.baseline?.successOk} bugged successOk=${result.regressed?.successOk} drift=${result.regressed?.drifted} | ~${result.regressed?.tokens} tok/run ===`,
);
process.exit(result.detected ? 0 : 1);
