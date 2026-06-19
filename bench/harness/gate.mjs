// Benchmark regression gate. Compares the FRESH raw results (written by bench-all.mjs) against the
// PREVIOUS row in bench/history.jsonl and fails (exit 1) on a regression. Policy (locked with the
// user): hard gate vs last + an RCR floor. Deterministic layers (A scripted, C replay) block; Layer B
// (a paid LLM loop) is never gated here.
//
//   node bench/harness/bench-all.mjs --full && node bench/harness/gate.mjs
//
// Hard fails:
//   - RCR < 1.0, or any false positive (Layer A — only when analysis.json is present this pass)
//   - VE drops > VE_TOL vs the last row (Layer A)
//   - selector detection not full, or consequence detection not full (Layer C)
//   - per-run replay tokens rise > TOKEN_TOL vs the last row (Layer C)
import { readFileSync, existsSync } from 'node:fs';

const VE_TOL = 0.03; // VE may dip at most 3% vs last (noise) before it's a regression
const TOKEN_TOL = 0.05; // per-run replay tokens may rise at most 5% vs last

function readRaw(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** The previous recorded row (the baseline we must not regress against), or null on first run. */
function lastRow() {
  if (!existsSync('bench/history.jsonl')) return null;
  const lines = readFileSync('bench/history.jsonl', 'utf8').trim().split('\n').filter(Boolean);
  const last = lines.at(-1);
  return last !== undefined ? JSON.parse(last) : null;
}

/** Parse a "3/3" detection-rate string into { detected, total }. */
function parseRate(rate) {
  if (typeof rate !== 'string') return null;
  const m = /^(\d+)\/(\d+)$/.exec(rate);
  return m === null ? null : { detected: Number(m[1]), total: Number(m[2]) };
}

const failures = [];
const scorecard = [];
const prev = lastRow();
// Only gate layers that ran THIS pass (a stale analysis.json must not be gated on a Layer-C pass).
const manifest = readRaw('bench/raw/bench-run.json');
const ranLayerA = manifest === null ? true : manifest.ranLayerA === true;

// ---- Layer A (scripted observation) — only when it was freshly run this pass ----
const analysis = ranLayerA ? readRaw('bench/raw/analysis.json') : null;
if (analysis !== null) {
  const iris = analysis.per_tool?.iris ?? {};
  const realRegressions = Object.values(analysis.per_scenario ?? {}).filter(
    (s) => s.expected_detect === true && s.by_tool?.iris?.verdict !== 'NOT MEASURED',
  ).length;
  const rcr = realRegressions ? +(iris.true_positives / realRegressions).toFixed(3) : null;
  const ve = iris.avg_tokens_o200k
    ? +(iris.true_positives / (iris.avg_tokens_o200k / 1000)).toFixed(2)
    : null;
  const fp = iris.false_positives ?? 0;

  if (rcr === null || rcr < 1.0) failures.push(`RCR floor: iris RCR=${rcr} (must be 1.0)`);
  if (fp > 0) failures.push(`false positives: iris FP=${fp} (must be 0)`);
  const lastVe = prev?.per_tool?.iris?.ve ?? null;
  if (lastVe !== null && ve !== null && ve < lastVe * (1 - VE_TOL)) {
    failures.push(
      `VE regressed: ${ve} < ${lastVe} (−${(((lastVe - ve) / lastVe) * 100).toFixed(1)}%)`,
    );
  }
  scorecard.push(['Layer A RCR', prev?.per_tool?.iris?.rcr ?? '—', rcr]);
  scorecard.push(['Layer A FP', '0', fp]);
  scorecard.push(['Layer A VE', lastVe ?? '—', ve]);
} else {
  scorecard.push(['Layer A', '—', 'not run this pass (advisory skip)']);
}

// ---- Layer C (deterministic replay) — always gated when the raws are present ----
const cost = readRaw('bench/raw/replay-bench.json');
const selector = readRaw('bench/raw/replay-detect.json');
const consequence = readRaw('bench/raw/replay-detect-consequence.json');
const lastC = prev?.layer_c ?? null;

if (selector !== null) {
  const r = parseRate(selector.detection_rate);
  if (r === null || r.detected < r.total) {
    failures.push(`selector detection not full: ${selector.detection_rate}`);
  }
  const lastR = parseRate(lastC?.selector_detection);
  if (lastR !== null && r !== null && r.total < lastR.total) {
    failures.push(`selector scenarios dropped: ${r.total} < ${lastR.total}`);
  }
  scorecard.push(['Layer C selector', lastC?.selector_detection ?? '—', selector.detection_rate]);
}
if (consequence !== null) {
  const r = parseRate(consequence.detection_rate);
  if (r === null || r.detected < r.total) {
    failures.push(`consequence detection not full: ${consequence.detection_rate}`);
  }
  scorecard.push([
    'Layer C consequence',
    lastC?.consequence_detection ?? '—',
    consequence.detection_rate,
  ]);
}
if (cost !== null) {
  const now = cost.per_run?.iris_replay_mean_tokens ?? null;
  const last = lastC?.replay_mean_tokens ?? null;
  if (last !== null && now !== null && now > last * (1 + TOKEN_TOL)) {
    failures.push(
      `replay tokens rose: ${now} > ${last} (+${(((now - last) / last) * 100).toFixed(1)}%)`,
    );
  }
  scorecard.push(['Layer C replay tok', last ?? '—', now]);
}

// ---- Report ----
console.log('\nBenchmark gate — fresh vs last baseline');
console.log('─'.repeat(56));
for (const [metric, was, now] of scorecard) {
  console.log(`  ${String(metric).padEnd(22)} ${String(was).padEnd(14)} → ${now}`);
}
console.log('─'.repeat(56));
if (analysis === null && cost === null && selector === null && consequence === null) {
  console.error('✗ no fresh results found — run `node bench/harness/bench-all.mjs` first.');
  process.exit(1);
}
if (failures.length > 0) {
  console.error(`\n✗ GATE FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✓ gate passed — no regression vs the last baseline.');
process.exit(0);
