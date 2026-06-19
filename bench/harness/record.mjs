// Append one measured row to bench/history.jsonl from the current analysis.json (+ Layer C raws).
// Usage: node bench/harness/record.mjs "<version-label>" "<note>"
// version-label + note are the only free text; all numbers come from the raw result files.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const version = process.argv[2] ?? 'unlabeled';
const note = process.argv[3] ?? '';
const a = JSON.parse(readFileSync('bench/raw/analysis.json', 'utf8'));

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
  if (cost === null && selector === null && consequence === null && stateOracle === null) {
    return null;
  }
  return {
    replay_mean_tokens: cost?.per_run?.iris_replay_mean_tokens ?? null,
    replay_ratio_vs_playwright: cost?.ratio_vs_playwright ?? null,
    selector_detection: selector?.detection_rate ?? null,
    selector_caught_mean_tokens: selector?.per_run_when_caught?.iris_replay_mean_tokens ?? null,
    consequence_detection: consequence?.detection_rate ?? null,
    state_detection: stateOracle?.detection_rate ?? null,
    state_caught_mean_tokens: stateOracle?.per_run_when_caught?.iris_replay_mean_tokens ?? null,
  };
}

// Per-tool denominator = real-regression scenarios (expected_detect true) that this tool
// actually MEASURED (NOT MEASURED scenarios like cross-component are excluded, not counted as misses).
function measuredRealRegressions(tool) {
  return Object.values(a.per_scenario).filter(
    (s) => s.expected_detect === true && s.by_tool?.[tool]?.verdict !== 'NOT MEASURED',
  ).length;
}

let sha = 'nogit';
try {
  sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch {
  /* */
}

const perTool = {};
for (const [tool, v] of Object.entries(a.per_tool)) {
  const realRegressions = measuredRealRegressions(tool);
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
const row = {
  version,
  note,
  date: new Date().toISOString().slice(0, 10),
  git_sha: sha,
  layer: layerC === null ? 'A' : 'A+C',
  measured_cells: a.measured_cells,
  total_cells: a.total_cells,
  not_measured: a.not_measured,
  per_tool: perTool,
  ...(layerC !== null ? { layer_c: layerC } : {}),
};
appendFileSync('bench/history.jsonl', JSON.stringify(row) + '\n');
console.log(
  'recorded',
  version,
  '→ iris VE',
  perTool.iris?.ve,
  'RCR',
  perTool.iris?.rcr,
  layerC !== null
    ? `| Layer C ${layerC.selector_detection} sel, ${layerC.consequence_detection} cons`
    : '',
);
