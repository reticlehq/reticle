// Full-flow token MODEL (deterministic, zero-cost proxy for the paid Layer-B bench). It neutralizes the
// loose "114k / 5.7x" claims using OUR measured data: the per-request tool-schema tax (schema-tax.json)
// + the median per-step observation payload each tool returns (Layer A clean runs). It models the real
// quadratic history re-send across an N-step agent flow, under BOTH caching policies.
//
// HONEST SCOPE: this is an observation+schema INPUT-token model. It excludes agent reasoning/output
// tokens (≈ tool-independent) and assumes one observation-bearing turn per step. The cross-tool RELATIVE
// comparison is robust (identical model + caching for all). The full paid measurement (real Claude
// `usage` across N≥20 runs) is specced in plan/token-bench-methodology.md and needs spend approval.
import { readFileSync, writeFileSync } from 'node:fs';

const N = Number(process.env.STEPS ?? 10); // a fixed 10-step flow (login → navigate → act → observe → assert)

// Per-request tool-schema tax (measured, schema-tax.json). CLIs = 0.
const schemaTax = JSON.parse(readFileSync('bench/raw/schema-tax.json', 'utf8')).results;
const SCHEMA = {
  iris_full: schemaTax.iris?.schema_tokens ?? 16014,
  iris_core: 5583, // measured: core profile, 12 tools
  playwright_mcp: schemaTax.playwright?.schema_tokens ?? 3130,
  devtools_mcp: schemaTax.devtools?.schema_tokens ?? 4499,
  agent_browser: 0,
  playwright_cli: 68, // the one-time `--help` the agent reads to learn the CLI (research §b)
};
// Median per-step observation payload (tokens) — measured Layer A clean runs (see iris-improvement-mission.md).
const OBS = {
  iris_full: 735,
  iris_core: 735, // same observation payloads; only the schema differs by profile
  playwright_mcp: 1294,
  devtools_mcp: 1031,
  agent_browser: 205,
  playwright_cli: 1346,
};

// Cumulative input over an N-turn flow. At turn t the prefill = schema + history(obs[1..t-1]) + obs[t].
// Uncached: every turn pays full schema + full history at 1x.
function uncached(schema, obs) {
  return N * schema + obs * ((N * (N + 1)) / 2); // N*schema + obs*Σt
}
// Cached (5-min TTL): schema written once at 1.25x then read at 0.1x; each observation fresh once at 1x
// then cache-read at 0.1x in later turns. Identical policy for every tool.
function cached(schema, obs) {
  const schemaCost = schema * (1.25 + 0.1 * (N - 1));
  const obsCost = obs * N + 0.1 * obs * ((N * (N - 1)) / 2);
  return Math.round(schemaCost + obsCost);
}

const tools = Object.keys(SCHEMA);
const rows = tools.map((t) => {
  const u = Math.round(uncached(SCHEMA[t], OBS[t]));
  const c = cached(SCHEMA[t], OBS[t]);
  return {
    tool: t,
    schema_tax: SCHEMA[t],
    per_step_obs: OBS[t],
    uncached_cumulative_input: u,
    cached_cumulative_input: c,
    cached_tokens_per_step: Math.round(c / N),
  };
});
rows.sort((a, b) => a.cached_cumulative_input - b.cached_cumulative_input);

// Headline ratios vs the cheapest, and Iris(core) vs Playwright MCP (the claim everyone cites).
const byTool = Object.fromEntries(rows.map((r) => [r.tool, r]));
const out = {
  metric: `full-flow token MODEL — ${N}-step flow, observation+schema input tokens, cached + uncached`,
  scope:
    'Deterministic proxy from measured schema tax + measured per-step observations. Excludes agent reasoning/output (~tool-independent). Relative comparison is robust; absolute paid measurement is specced separately.',
  steps: N,
  caching_policy:
    'schema+history cached: write 1.25x once, read 0.1x thereafter (5-min TTL); identical for all tools',
  rows,
  headline: {
    iris_core_vs_playwright_mcp_cached: +(
      byTool.playwright_mcp.cached_cumulative_input / byTool.iris_core.cached_cumulative_input
    ).toFixed(2),
    iris_full_vs_playwright_mcp_cached: +(
      byTool.playwright_mcp.cached_cumulative_input / byTool.iris_full.cached_cumulative_input
    ).toFixed(2),
    agent_browser_is_leanest_observe:
      'agent-browser stays cheapest on raw observation tokens — but catches only 72.7% of regressions (Layer A). Cheap because blind.',
    note: 'Iris core ≈ competitive with the MCP substrates on tokens AND uniquely 100% detection + deterministic replay (122 tok/regression-run). Efficiency AND correctness.',
  },
};
console.log(JSON.stringify(out, null, 2));
writeFileSync('bench/raw/full-flow-token-model.json', JSON.stringify(out, null, 2));
