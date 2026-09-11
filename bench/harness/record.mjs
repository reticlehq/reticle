// Append one measured row to bench/history.jsonl from the current analysis.json (+ Layer C raws).
// Usage: node bench/harness/record.mjs "<version-label>" "<note>"
// version-label + note are the only free text; all numbers come from the raw result files.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { HARNESS_REVISION } from './baseline-provenance.mjs';
import { execSync } from 'node:child_process';
// Per-tool denominator = real-regression scenarios this tool actually MEASURED. A NOT MEASURED
// scenario is excluded rather than counted as a miss; a tool with no cell at all is excluded for the
// stronger reason that there is nothing there to have measured. See tool-coverage.mjs.
import { measuredRealRegressions } from './tool-coverage.mjs';

const version = process.argv[2] ?? 'unlabeled';
const note = process.argv[3] ?? '';
const a = JSON.parse(readFileSync('bench/raw/analysis.json', 'utf8'));

/**
 * A baseline must come from the commit it claims to describe.
 *
 * This script used to record from whatever analysis.json was on disk. The 2.7.0 baseline is the proof
 * that this matters: it reports `broken-form-validation` as measured, and at that commit the
 * injector's anchor did not match the fixture, so the scenario could not have been injected. Every
 * later run was then compared against a baseline describing a DIFFERENT run — and the most expensive
 * scenario in the suite (2,736 tokens against a ~806 median) being present on one side and absent on
 * the other reads as a 3.9% efficiency regression that never happened.
 *
 * The gate is only as honest as its memory. Refuse rather than record a row that cannot be trusted:
 * a wrong baseline is worse than no baseline, because it produces confident false verdicts for
 * months.
 */
function assertFreshAnalysis() {
  let head = 'nogit';
  try {
    head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return; // no git: nothing to check against, and the sha is already recorded as 'nogit'
  }
  if (a.git_sha === undefined) {
    console.error(
      'refusing to record: bench/raw/analysis.json carries no git_sha, so it predates provenance ' +
        'stamping and cannot be shown to come from this commit. Re-run `pnpm bench:full`.',
    );
    process.exit(1);
  }
  if (a.git_sha !== head) {
    console.error(
      `refusing to record: analysis.json was generated at ${a.git_sha} but HEAD is ${head}. ` +
        'That file is from a different run — recording it would create a baseline that describes ' +
        'code nobody is testing. Re-run `pnpm bench:full`.',
    );
    process.exit(1);
  }
}
assertFreshAnalysis();

/** Read an optional raw JSON file (Layer C may not have been run this pass). */
function readRaw(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * Layer C (deterministic replay) block for the row — RRE cost + detection rates — so the gate can
 * compare them vs the previous run. Null when the Layer C raws are absent (Layer-A-only pass).
 */
function layerCBlock() {
  const cost = readRaw('bench/raw/replay-bench.json');
  const selector = readRaw('bench/raw/replay-detect.json');
  const consequence = readRaw('bench/raw/replay-detect-consequence.json');
  const stateOracle = readRaw('bench/raw/replay-detect-state.json');
  if (null === cost && null === selector && null === consequence && null === stateOracle) {
    return null;
  }
  return {
    replay_mean_tokens: cost?.per_run?.reticle_replay_mean_tokens ?? null,
    replay_ratio_vs_playwright: cost?.ratio_vs_playwright ?? null,
    selector_detection: selector?.detection_rate ?? null,
    selector_caught_mean_tokens: selector?.per_run_when_caught?.reticle_replay_mean_tokens ?? null,
    consequence_detection: consequence?.detection_rate ?? null,
    state_detection: stateOracle?.detection_rate ?? null,
    state_caught_mean_tokens: stateOracle?.per_run_when_caught?.reticle_replay_mean_tokens ?? null,
  };
}

/**
 * The intent+context block — the headline false-green rate in each arm, so the gate can compare the
 * ON arm against the last row rather than only against its own OFF arm.
 *
 * Null when the pass did not run, and null when it ran WITHOUT measuring: an unmeasured pass writes
 * an artifact too, and recording its absent arms as a baseline would hand every later run a
 * comparison against nothing that reads exactly like a comparison against something.
 */
function intentEffectBlock() {
  const raw = readRaw('bench/raw/intent-effect.json');
  if (null === raw || true !== raw.measured) return null;
  return {
    false_green_rate_off: raw.arms?.off?.false_green_rate ?? null,
    false_green_rate_on: raw.arms?.on?.false_green_rate ?? null,
    false_green_spread_off: raw.arms?.off?.false_green_spread ?? null,
    false_green_spread_on: raw.arms?.on?.false_green_spread ?? null,
    re_query_rate_off: raw.arms?.off?.re_query_rate ?? null,
    re_query_rate_on: raw.arms?.on?.re_query_rate ?? null,
    steps_to_correct_off: raw.arms?.off?.steps_to_correct_mean ?? null,
    steps_to_correct_on: raw.arms?.on?.steps_to_correct_mean ?? null,
    propagation_depth_off: raw.arms?.off?.propagation_depth_mean ?? null,
    propagation_depth_on: raw.arms?.on?.propagation_depth_mean ?? null,
    runs: raw.runs_requested ?? null,
    model: raw.model ?? null,
    outcome: raw.verdict?.outcome ?? null,
  };
}

let sha = 'nogit';
try {
  sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* */
}

const perTool = {};
for (const [tool, v] of Object.entries(a.per_tool)) {
  const realRegressions = measuredRealRegressions(a.per_scenario, tool);
  const rcr = realRegressions ? +(v.true_positives / realRegressions).toFixed(3) : null;
  const ve = v.avg_tokens_o200k
    ? +(v.true_positives / (v.avg_tokens_o200k / 1000)).toFixed(2)
    : null;
  perTool[tool] = {
    rcr,
    ve,
    tp: v.true_positives,
    real_regressions: realRegressions,
    detection_accuracy: v.detection_accuracy,
    false_negative_rate: v.false_negative_rate,
    avg_tokens_o200k: v.avg_tokens_o200k,
    p95_latency_ms: v.p95_latency_ms,
  };
}

const layerC = layerCBlock();
const intentEffect = intentEffectBlock();
const row = {
  version,
  note,
  // Which instrument measured this. The gate refuses a baseline recorded by a different one, because
  // comparing across harness revisions reports the change in the harness as a change in the product.
  harness_revision: HARNESS_REVISION,
  date: new Date().toISOString().slice(0, 10),
  git_sha: sha,
  layer: null === layerC ? 'A' : 'A+C',
  measured_cells: a.measured_cells,
  total_cells: a.total_cells,
  not_measured: a.not_measured,
  ...(a.tools_not_run?.length > 0 ? { tools_not_run: a.tools_not_run } : {}),
  per_tool: perTool,
  ...(layerC !== null ? { layer_c: layerC } : {}),
  ...(intentEffect !== null ? { intent_effect: intentEffect } : {}),
};
appendFileSync('bench/history.jsonl', JSON.stringify(row) + '\n');
console.log(
  'recorded',
  version,
  '→ reticle VE',
  perTool.reticle?.ve,
  'RCR',
  perTool.reticle?.rcr,
  layerC !== null
    ? `| Layer C ${layerC.selector_detection} sel, ${layerC.consequence_detection} cons`
    : '',
);
