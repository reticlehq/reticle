// Compound-expect regression (Layer C): does a SAVED flow keep both halves of a two-request claim?
//
// The agent asserts the way it always does — one `act_and_wait { until }` — and the claim is a
// conjunction of two requests of the SAME kind:
//
//   allOf[ net { POST /api/generate-script, count: 1 },   // exactly one generate (no double-submit)
//          net { /api/legacy-telemetry,     count: 0 } ]  // and never the forbidden endpoint
//
// When a saved step's `expect` was a flat struct with ONE `net` slot, this conjunction had no
// representation and the step kept less than the agent asserted. Measured against that format, the
// double-submit was still caught and the forbidden call replayed GREEN. With the predicate stored
// verbatim and waited on directly, each bug turns the replay red on the arm it breaks.
//
// Detected = the clean replay holds AND both bugged replays fail.
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const FLOW = 'compound-compose';
const UNTIL = {
  kind: 'allOf',
  predicates: [
    { kind: 'net', method: 'POST', urlContains: '/api/generate-script', count: 1 },
    { kind: 'net', urlContains: '/api/legacy-telemetry', count: 0 },
  ],
};
const BUGS = ['double-submit', 'forbidden-call'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (t) => {
  try {
    return JSON.parse(t || '{}');
  } catch {
    return {};
  }
};

async function replayOnce(a) {
  const rep = await a.c.callTool('reticle_flow_replay', { flowName: FLOW });
  const obj = parse(rep.text);
  const steps = Array.isArray(obj.steps) ? obj.steps : [];
  return {
    status: obj.status ?? 'unknown',
    drift: steps.map((s) => s?.drift?.reasonKind ?? s?.drift?.reason).find(Boolean) ?? null,
    tokens: measure(rep.text || '').tokens_o200k,
  };
}

const a = new ReticleAdapter(URL);
await a.start();
let result;
try {
  await a.c.callTool('reticle_record', { action: 'start', recordingName: FLOW });
  await a.login();
  await a.gotoView('compose');
  await sleep(300);
  const prompt = await a._refByTestid('compose-prompt');
  if (prompt.ref) {
    await a.c.callTool('reticle_act', {
      ref: prompt.ref,
      action: 'fill',
      args: { value: 'ship the new pricing page' },
    });
  }
  const live = await a.prove({ testid: 'compose-generate', until: UNTIL });
  await a.c.callTool('reticle_record', { action: 'stop', recordingName: FLOW });
  const saved = parse((await a.c.callTool('reticle_flow_save', { flowName: FLOW })).text);

  await a.refresh();
  await sleep(1500);
  const baseline = await replayOnce(a);

  const regressed = {};
  for (const bug of BUGS) {
    await a.c.callTool('reticle_navigate', {
      url: `${URL}${URL.includes('?') ? '&' : '?'}reticle-bug=${bug}`,
    });
    await sleep(1800);
    regressed[bug] = await replayOnce(a);
  }
  const caught = BUGS.filter((bug) => regressed[bug].status !== 'ok');
  result = {
    live_verdict: parse(live.text).verified ?? null,
    saved_grade: saved.grade ?? saved.assertionGrade ?? null,
    baseline,
    regressed,
    caught: caught.length,
    of: BUGS.length,
    detected: 'ok' === baseline.status && caught.length === BUGS.length,
  };
} finally {
  await a.stop();
}

const summary = {
  dimension: 'Compound expect (Layer C) — a saved allOf of two net claims keeps BOTH arms',
  until: UNTIL,
  ...result,
  honest_verdict: result.detected
    ? `BOTH bugs caught on replay (${result.caught}/${result.of}); the clean replay held.`
    : `caught ${result.caught}/${result.of}; clean replay status=${result.baseline.status}. A green under a bug means the saved flow is not checking what the agent asserted.`,
};
writeFileSync('bench/raw/compound-expect-bench.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  `\n=== compound-expect: ${result.caught}/${result.of} caught | clean=${result.baseline.status} | grade=${result.saved_grade} ===`,
);
process.exit(result.detected ? 0 : 1);
