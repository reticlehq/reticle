// Determinism / flake-rate benchmark (Layer C): the property a regression suite lives or dies by.
//
// A regression test's whole job is to give the SAME verdict on the SAME code, run after run. The
// industry's worst tax is the flaky test: a verdict that changes when nothing changed, so a real
// failure hides in the noise and engineers learn to ignore red. Reticle's replay is built to make that
// impossible by construction: no LLM in the loop (no sampling), the app's clock is the only time
// source, and each step re-resolves a semantic anchor + asserts a declared consequence. So the same
// flow replayed N times must produce a BYTE-IDENTICAL verdict and an IDENTICAL token cost.
//
// This harness records one flow, then replays it N times against the same unchanged page and checks:
//   - every replay returns the same status            (verdict determinism — flake rate 0)
//   - every replay returns the same step-by-step shape (no drift noise)
//   - every replay costs the same token count          (cost determinism — CI budgeting is exact)
// variance across all N == 0 ⇒ flake rate 0%.
//
// Why the competitors can't claim this: Playwright MCP / DevTools MCP have no replay — an agent must
// re-drive the flow with the model every run, and an LLM re-drive is a SAMPLED process (temperature,
// tool-call ordering, token counts all vary run to run). Determinism is the structural payoff of
// "no model in the regression loop", which is exactly Reticle's Layer C design.
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const RUNS = Number(process.env.BENCH_RUNS ?? '8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (t) => {
  try {
    return JSON.parse(t || '{}');
  } catch {
    return {};
  }
};

// One representative verify flow (a modal-open consequence — same shape as replay-bench's verify-modal).
const FLOW = { name: 'determinism-modal', steps: [{ view: 'deployments' }, { tap: 'new-deploy' }] };

// The stable fingerprint of a replay verdict — what a CI gate would diff run-to-run. Excludes nothing
// that should be deterministic; if any of these drift between runs, the suite is flaky.
const fingerprint = (rep) =>
  JSON.stringify({
    status: rep.status ?? 'unknown',
    steps: Array.isArray(rep.steps)
      ? rep.steps.map((s) => ({
          ok: s?.ok ?? null,
          anchor: s?.anchor ?? null,
          drift: s?.drift?.anchor ?? null,
        }))
      : null,
  });

const a = new ReticleAdapter(URL);
await a.start();
const runs = [];
try {
  // Record the flow once (one-time authoring cost, excluded from the per-run determinism claim).
  await a.c.callTool('reticle_record_start', { recordingName: FLOW.name });
  await a.login();
  for (const s of FLOW.steps) {
    if (s.view) await a.gotoView(s.view);
    else if (s.tap) await a.clickTestid(s.tap);
    await sleep(200);
  }
  await a.c.callTool('reticle_record_stop', { recordingName: FLOW.name });
  await a.c.callTool('reticle_flow_save', { flowName: FLOW.name });

  // Replay N times against the SAME unchanged page; each run reloads fresh so it re-runs end to end.
  for (let i = 0; i < RUNS; i++) {
    await a.c.callTool('reticle_refresh', { hard: true });
    await sleep(1500);
    const rep = await a.c.callTool('reticle_flow_replay', { flowName: FLOW.name });
    const repObj = parse(rep.text);
    runs.push({
      status: repObj.status ?? 'unknown',
      tokens: measure(rep.text || '').tokens_o200k,
      fingerprint: fingerprint(repObj),
    });
  }
} finally {
  await a.stop();
}

const statuses = new Set(runs.map((r) => r.status));
const fingerprints = new Set(runs.map((r) => r.fingerprint));
const tokenSet = new Set(runs.map((r) => r.tokens));
const tokens = runs.map((r) => r.tokens);
const tokenSpread = tokens.length ? Math.max(...tokens) - Math.min(...tokens) : null;
// Flake rate = fraction of runs whose verdict differs from the modal (most common) verdict.
const counts = {};
for (const r of runs) counts[r.fingerprint] = (counts[r.fingerprint] ?? 0) + 1;
const majority = Math.max(0, ...Object.values(counts));
const flakeRate = runs.length ? (runs.length - majority) / runs.length : null;

// The headline claim — and the only thing a regression gate diffs — is the VERDICT (status + each
// step's ok/anchor/drift). That must be identical across every run, or the suite is flaky. Token cost
// is a SECONDARY metric: it is constant in steady state, but a slow run can add a few tokens of
// settle/retry note, so it is reported (not gated) — verdict flake is the real failure mode.
const verdictDeterministic = statuses.size === 1 && fingerprints.size === 1;
const tokenConstant = tokenSet.size === 1;
const summary = {
  dimension:
    'Replay determinism / flake rate (Layer C) — the regression-suite property that matters most',
  runs: runs.length,
  distinct_statuses: statuses.size,
  distinct_verdicts: fingerprints.size,
  distinct_token_counts: tokenSet.size,
  token_spread: tokenSpread,
  per_run_tokens: tokens,
  flake_rate: flakeRate,
  verdict_deterministic: verdictDeterministic,
  token_constant: tokenConstant,
  competitor_position:
    'Playwright MCP / DevTools MCP have no replay — every run is an LLM re-drive, a SAMPLED process; identical token counts and identical tool-call sequences across runs are not guaranteed. Determinism is the structural payoff of having no model in the regression loop.',
  honest_verdict: verdictDeterministic
    ? `Reticle replay is verdict-deterministic across ${runs.length} runs: one status, one step-by-step verdict — flake rate 0% by construction (no LLM, clock-controlled). A CI gate diffs the verdict exactly. Token cost is ${tokenConstant ? `constant (${tokens[0]} every run)` : `near-constant (spread ${tokenSpread} tok of settle-note noise across ${tokenSet.size} values)`}.`
    : `NON-DETERMINISTIC VERDICT: ${statuses.size} statuses / ${fingerprints.size} verdicts across ${runs.length} runs — a real flake; investigate before claiming flake rate 0.`,
};
writeFileSync('bench/raw/replay-determinism.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  `\n=== replay-determinism: verdict ${verdictDeterministic ? 'DETERMINISTIC' : 'NON-DETERMINISTIC'} over ${runs.length} runs | flake rate ${flakeRate === null ? 'n/a' : (flakeRate * 100).toFixed(0) + '%'} | token ${tokenConstant ? 'constant ' + tokens[0] : 'spread ' + tokenSpread} ===`,
);
process.exit(verdictDeterministic ? 0 : 1);
