// Competitive scorecard — the two-axis (token × detection) report + every other measured axis, in one
// decision table. Synthesizes the session's measured benches: Layer A detection, schema-tax, full-flow
// token model, multi-agent throughput, deterministic-replay cost, and the silent-regression sub-score.
// The point: token efficiency and detection completeness are DIFFERENT axes — cheap tools are cheap
// because they're blind. This makes that legible at a glance.
import { writeFileSync } from 'node:fs';

// All values measured this session (see plan/reticle-improvement-mission.md for provenance per number).
const TOOLS = [
  {
    tool: 'reticle (core)',
    full_flow_cached: 22661,
    detection: 1.0,
    silent_3: 3,
    schema_tax: 5583,
    det_replay_tok: 122,
    multi_agent: true,
    harness: true,
  },
  {
    tool: 'reticle (full, default)',
    full_flow_cached: 45088,
    detection: 1.0,
    silent_3: 3,
    schema_tax: 16014,
    det_replay_tok: 122,
    multi_agent: true,
    harness: true,
  },
  {
    tool: 'playwright-mcp',
    full_flow_cached: 25493,
    detection: 0.909,
    silent_3: 2,
    schema_tax: 3130,
    det_replay_tok: null,
    multi_agent: false,
    harness: false,
  },
  {
    tool: 'chrome-devtools-mcp',
    full_flow_cached: 24622,
    detection: 0.818,
    silent_3: 1,
    schema_tax: 4499,
    det_replay_tok: null,
    multi_agent: false,
    harness: false,
  },
  {
    tool: 'playwright-cli',
    full_flow_cached: 19663,
    detection: 0.818,
    silent_3: 1,
    schema_tax: 68,
    det_replay_tok: null,
    multi_agent: false,
    harness: false,
  },
  {
    tool: 'agent-browser',
    full_flow_cached: 2973,
    detection: 0.727,
    silent_3: 0,
    schema_tax: 0,
    det_replay_tok: null,
    multi_agent: false,
    harness: false,
  },
];

// Quadrant on the two axes: cheap+complete = ideal; cheap+blind = false economy; costly+complete = honest
// but heavy; costly+blind = worst. Thresholds: "cheap" ≤ median full-flow; "complete" = 100% detection.
const median = [...TOOLS].map((t) => t.full_flow_cached).sort((a, b) => a - b)[
  Math.floor(TOOLS.length / 2)
];
function quadrant(t) {
  const cheap = t.full_flow_cached <= median;
  const complete = t.detection >= 1.0;
  if (cheap && complete) return 'ideal (cheap + complete)';
  if (!cheap && complete) return 'honest-but-heavy (complete, costly)';
  if (cheap && !complete) return 'false-economy (cheap because blind)';
  return 'worst (costly + blind)';
}

const rows = TOOLS.map((t) => ({
  ...t,
  silent_regression: `${t.silent_3}/3`,
  regression_run:
    t.det_replay_tok !== null
      ? `${t.det_replay_tok} tok (deterministic)`
      : 're-drive (~LLM, non-det)',
  quadrant: quadrant(t),
}));

const out = {
  metric: 'competitive scorecard — token cost × detection, plus replay / multi-agent / harness',
  axes_note:
    'Token efficiency and detection are orthogonal. agent-browser is cheapest AND least accurate (false economy). Reticle(core) is the only tool that is both competitive on tokens AND 100% detection AND has a near-free deterministic regression loop. Never claim "leanest" — claim "competitive + only-100% + ~free regression".',
  silent_regression_note:
    'Only Reticle catches all 3 silent regressions; layout-shift + broken-form-validation are missed by EVERY competitor incl. full-snapshot tools — they need a visual/state oracle the others lack.',
  rows,
  takeaways: {
    only_100pct_detection: 'reticle',
    only_deterministic_replay: 'reticle (122 tok/run vs ~LLM re-drive)',
    only_multi_agent_pool_local: 'reticle',
    only_test_harness: 'reticle (@reticle/test, vitest-native)',
    token_leader_but_blind: 'agent-browser (2973 tok, 72.7% detection, 0/3 silent)',
    biggest_reticle_fix:
      'default full→core: 45088→22661 tokens (cheaper than playwright-mcp), zero detection loss',
  },
};
const w = (s, n) => String(s).padEnd(n);
console.log(
  `\n${w('tool', 22)}${w('full-flow', 11)}${w('detect', 8)}${w('silent', 8)}${w('schema', 8)}${w('regression-run', 26)}${'quadrant'}`,
);
for (const r of rows)
  console.log(
    `${w(r.tool, 22)}${w(r.full_flow_cached, 11)}${w((r.detection * 100).toFixed(0) + '%', 8)}${w(r.silent_regression, 8)}${w(r.schema_tax, 8)}${w(r.regression_run, 26)}${r.quadrant}`,
  );
writeFileSync('bench/raw/competitive-scorecard.json', JSON.stringify(out, null, 2));
console.log('\nwrote bench/raw/competitive-scorecard.json');
