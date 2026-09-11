// Phase 4 analysis. Reads observation-results.json, computes per-tool aggregates
// (avg/median tokens, p95 latency, detection accuracy, FN/FP rates) and per-scenario
// winners. Pure arithmetic over measured rows — no synthetic data.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { toolsMeasured } from './tool-coverage.mjs';

/**
 * Which commit produced these numbers.
 *
 * analysis.json carried no provenance, so `record.mjs` would happily write a baseline row from
 * WHATEVER file happened to be on disk — including one left by a run weeks earlier. That is not
 * hypothetical: the recorded 2.7.0 baseline claims `broken-form-validation` was measured, and at that
 * commit the injector's anchor did not match the fixture, so it could not have been injected at all.
 * Every later gate then compared an honest run against a baseline describing a different one, and
 * reported a regression that was an artefact of the comparison.
 *
 * A number without provenance cannot be a baseline. Stamped here, at the moment the numbers are
 * computed, and checked by record.mjs before it will write a row.
 */
function headSha() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'nogit';
  }
}

const rows = JSON.parse(readFileSync('bench/raw/observation-results.json', 'utf8'));
// The columns this analysis KNOWS ABOUT, in report order. Which of them a run actually measured is
// decided by BENCH_TOOLS, and iterating the full list regardless is how two tools that never ran
// were recorded as having caught nothing across the whole grid. See tool-coverage.mjs.
const ALL_TOOLS = ['playwright', 'devtools', 'reticle', 'agentbrowser', 'playwrightcli'];
const TOOLS = toolsMeasured(rows, ALL_TOOLS);
const measured = rows.filter((r) => r.verdict !== 'NOT MEASURED');

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const round = (x) => (null === x ? null : Math.round(x));

const perTool = {};
for (const tool of TOOLS) {
  const tr = measured.filter((r) => r.tool === tool);
  // Spelled out rather than `!= null`. The loose form was the right INTENT — reject null and
  // undefined, keep 0 — and tightening it to `!== null` alone would let an undefined cell into
  // the average as NaN, which is the failure this file is least able to notice.
  const present = (x) => x !== null && x !== undefined;
  const toks = tr.map((r) => r.tokens_o200k).filter(present);
  const lats = tr.map((r) => r.latency_ms).filter(present);
  // detection confusion vs expected_detect
  let tp = 0,
    tn = 0,
    fp = 0,
    fn = 0;
  for (const r of tr) {
    if (r.expected_detect && r.detected_issue) tp++;
    else if (r.expected_detect && !r.detected_issue) fn++;
    else if (!r.expected_detect && r.detected_issue) fp++;
    else tn++;
  }
  const graded = tp + tn + fp + fn;
  perTool[tool] = {
    cells_measured: tr.length,
    avg_tokens_o200k: round(mean(toks)),
    median_tokens_o200k: round(median(toks)),
    p95_latency_ms: round(pct(lats, 95)),
    median_latency_ms: round(median(lats)),
    detection_accuracy: graded ? +((tp + tn) / graded).toFixed(3) : null,
    true_positives: tp,
    true_negatives: tn,
    false_positives: fp,
    false_negatives: fn,
    false_negative_rate: tp + fn ? +(fn / (tp + fn)).toFixed(3) : null,
    false_positive_rate: fp + tn ? +(fp / (fp + tn)).toFixed(3) : null,
  };
}

// Per-scenario: token winner among tools that correctly detected.
const scenarios = [...new Set(rows.map((r) => r.scenario))];
const perScenario = {};
for (const s of scenarios) {
  const sr = rows.filter((r) => r.scenario === s);
  const correct = sr.filter(
    (r) => r.verdict !== 'NOT MEASURED' && r.detected_issue === r.expected_detect,
  );
  const cheapestCorrect = correct
    .slice()
    .sort((a, b) => (a.tokens_o200k ?? 1e9) - (b.tokens_o200k ?? 1e9))[0];
  perScenario[s] = {
    expected_detect: sr[0]?.expected_detect,
    by_tool: Object.fromEntries(
      sr.map((r) => [
        r.tool,
        {
          detected: r.detected_issue,
          correct: r.detected_issue === r.expected_detect,
          tokens: r.tokens_o200k,
          latency_ms: r.latency_ms,
          verdict: r.verdict,
        },
      ]),
    ),
    cheapest_correct_tool: cheapestCorrect?.tool ?? null,
    cheapest_correct_tokens: cheapestCorrect?.tokens_o200k ?? null,
  };
}

const out = {
  generated_from: 'bench/raw/observation-results.json',
  git_sha: headSha(),
  generated_at: new Date().toISOString(),
  layer: 'A (observation cost)',
  total_cells: rows.length,
  measured_cells: measured.length,
  // Named rather than silently omitted: a reader of this file should be able to tell a column that
  // was not run from a column that ran and scored nothing.
  tools_not_run: ALL_TOOLS.filter((t) => !TOOLS.includes(t)),
  not_measured: rows
    .filter((r) => 'NOT MEASURED' === r.verdict)
    .map((r) => `${r.scenario}/${r.tool}`),
  per_tool: perTool,
  per_scenario: perScenario,
};
writeFileSync('bench/raw/analysis.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.per_tool, null, 2));
console.log('\nNOT MEASURED:', out.not_measured.join(', ') || 'none');
