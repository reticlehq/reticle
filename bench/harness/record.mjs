// Append one measured row to bench/history.jsonl from the current analysis.json.
// Usage: node bench/harness/record.mjs "<version-label>" "<note>"
// version-label + note are the only free text; all numbers come from analysis.json.
import { readFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const version = process.argv[2] ?? 'unlabeled';
const note = process.argv[3] ?? '';
const a = JSON.parse(readFileSync('bench/raw/analysis.json', 'utf8'));

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

const row = {
  version,
  note,
  date: new Date().toISOString().slice(0, 10),
  git_sha: sha,
  layer: 'A',
  measured_cells: a.measured_cells,
  total_cells: a.total_cells,
  not_measured: a.not_measured,
  per_tool: perTool,
};
appendFileSync('bench/history.jsonl', JSON.stringify(row) + '\n');
console.log('recorded', version, '→ iris VE', perTool.iris?.ve, 'RCR', perTool.iris?.rcr);
