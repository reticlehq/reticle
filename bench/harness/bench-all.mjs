// One command to run the benchmark suite (the regression gate's data-collection half).
//
//   node bench/harness/bench-all.mjs           # deterministic Layer C (fast, pure Iris) — default
//   node bench/harness/bench-all.mjs --full     # + Layer A (scripted observation; slow, boots tool MCPs)
//
// Layer B (a real LLM in the loop) is NEVER run here — it costs money and needs a key; it stays an
// advisory, run-by-hand layer. This orchestrates the EXISTING harness scripts (no re-measurement) and
// aborts on the first failure. Each script writes its own bench/raw/*.json; gate.mjs reads those.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const FULL = process.argv.includes('--full');
const PORT = process.env.BENCH_IRIS_PORT ?? '4455';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic, offline, pure-Iris layers — always run (the gate's hard floor).
const LAYER_C = [
  'bench/harness/replay-bench.mjs', // RRE cost: tokens/regression-run
  'bench/harness/replay-detect.mjs', // selector-removal detection (3/3)
  'bench/harness/replay-detect-consequence.mjs', // green-but-wrong detection (2/2)
  'bench/harness/replay-detect-state.mjs', // store-truth oracle catches a dead handler (state predicate)
  'bench/harness/network-cardinality-bench.mjs', // net.count oracle catches a double-submit (presence passes)
  'bench/harness/console-clean-bench.mjs', // clean-console oracle catches a silent console.error on an action
  'bench/harness/state-blast-radius-bench.mjs', // state invariant catches an action's unintended store side-effect
  'bench/harness/suite-rre.mjs', // suite-scale RRE: iris_flow_verify read-cost ~constant in K (compounding)
  'bench/harness/replay-determinism.mjs', // flake rate: verdict-deterministic across N replays (0% by construction)
];
// Scripted observation cost + detection accuracy. Slow (~12 min) and boots Playwright/DevTools MCPs.
const LAYER_A = ['bench/harness/run-observation.mjs', 'bench/harness/analyze.mjs'];

/** Free any iris daemon left on the bench port so the next script starts from a clean session. */
function cleanupDaemon() {
  try {
    execFileSync('node', ['packages/server/dist/cli.js', 'stop', '--port', PORT, '--quiet'], {
      stdio: 'ignore',
    });
  } catch {
    /* none running — fine */
  }
}

async function runScript(path) {
  console.log(`\n▶ ${path}`);
  const started = Date.now();
  try {
    execFileSync('node', [path], { stdio: 'inherit' });
  } catch (error) {
    console.error(`\n✗ ${path} FAILED (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
  console.log(`✓ ${path} (${Math.round((Date.now() - started) / 1000)}s)`);
  return true;
}

const scripts = [...(FULL ? LAYER_A : []), ...LAYER_C];
console.log(`bench-all: ${FULL ? 'Layer A + Layer C' : 'Layer C only (pass --full for Layer A)'}`);

for (const path of scripts) {
  cleanupDaemon();
  await sleep(1000);
  const ok = await runScript(path);
  if (!ok) {
    cleanupDaemon();
    console.error('\nbench-all aborted — a layer failed. Fix it before gating.');
    process.exit(1);
  }
}
cleanupDaemon();
// Manifest of what ran THIS pass, so the gate only checks freshly-measured layers (a stale
// analysis.json from a prior Layer A run must not be gated on a Layer-C-only pass).
writeFileSync(
  'bench/raw/bench-run.json',
  JSON.stringify({ ranLayerA: FULL, ranLayerC: true, at: new Date().toISOString() }, null, 2),
);
console.log(
  '\nbench-all complete. Run `node bench/harness/gate.mjs` to compare vs the last baseline.',
);
process.exit(0);
