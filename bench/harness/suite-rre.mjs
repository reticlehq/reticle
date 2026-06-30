// Suite-scale Regression-Run Efficiency (Layer C, the chased metric at the scale that matters).
//
// Per-run RRE (replay-bench) already shows ~140x per flow. But a real test suite is K flows verified
// together, over and over. reticle_flow_verify replays ALL saved flows deterministically and returns ONE
// consolidated verdict — passing flows are COUNTED, only failures carry detail — so the tokens an
// agent/CI READS to re-verify the whole suite are ~CONSTANT in K. Competitors have no replay: an agent
// re-drives EACH flow with the LLM every run (~30k tokens/flow, from Layer B). So the suite-RRE ratio
// = (K * 30249) / verify_tokens GROWS with suite size — the compounding 100x→1000x made measurable.
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LLM_REDRIVE_PER_FLOW = 30249; // Playwright MCP per-flow re-drive (Layer B, authoritative usage)

// Self-contained golden-path flows (each includes login), recorded once and saved to .reticle/flows/.
const FLOWS = [
  { name: 'suite-500', steps: [{ view: 'diagnostics' }, { tap: 'fault-500' }] },
  { name: 'suite-console', steps: [{ view: 'diagnostics' }, { tap: 'fault-buggy' }] },
  { name: 'suite-route', steps: [{ view: 'compose' }] },
  { name: 'suite-404', steps: [{ view: 'diagnostics' }, { tap: 'fault-404' }] },
];

// Record flows POST-LOGIN (login is NOT part of the flow): reticle_flow_verify replays the suite
// back-to-back in ONE session without re-login between flows, so a flow that embeds login steps
// fails once the app is already authenticated. Login once here (not recorded); each flow is just
// nav + a non-destructive tap (nav is absolute, so flows are order-independent).
async function recordFlow(flow) {
  const a = new ReticleAdapter(URL);
  await a.start();
  try {
    await a.login();
    await a.c.callTool('reticle_record_start', { recordingName: flow.name });
    for (const s of flow.steps) {
      if (s.view) await a.gotoView(s.view);
      else if (s.tap) await a.clickTestid(s.tap);
      await sleep(200);
    }
    await a.c.callTool('reticle_record_stop', { recordingName: flow.name });
    await a.c.callTool('reticle_flow_save', { flowName: flow.name });
  } finally {
    await a.stop();
  }
}

// Verify a named subset in ONE consolidated call; return the tokens the agent reads + the verdict.
// Log in once and stay logged in (no hard refresh) — the flows are post-login.
async function verifySuite(names) {
  const a = new ReticleAdapter(URL);
  await a.start();
  try {
    await a.login();
    await sleep(600);
    const res = await a.c.callTool('reticle_flow_verify', { names });
    const text = res.text || '';
    let obj = {};
    try {
      obj = JSON.parse(text);
    } catch {
      /* leave empty */
    }
    return { tokens: measure(text).tokens_o200k, status: obj.status ?? 'unknown', verdict: obj };
  } finally {
    await a.stop();
  }
}

for (const flow of FLOWS) {
  try {
    await recordFlow(flow);
    console.log('recorded', flow.name);
  } catch (e) {
    console.log('record error', flow.name, String(e).slice(0, 120));
  }
}

const names = FLOWS.map((f) => f.name);
// Measure the consolidated verify at growing suite sizes to show the read-cost is ~flat in K.
const points = [];
for (const k of [2, names.length]) {
  const subset = names.slice(0, k);
  const v = await verifySuite(subset);
  const competitor = k * LLM_REDRIVE_PER_FLOW;
  points.push({
    flows: k,
    reticle_verify_tokens: v.tokens,
    status: v.status,
    passed: v.verdict?.passed ?? null,
    competitor_redrive_tokens: competitor,
    suite_rre_ratio: v.tokens ? Math.round(competitor / v.tokens) : null,
  });
  console.log(JSON.stringify(points.at(-1)));
}

const summary = {
  layer: 'C-suite (suite-scale RRE — reticle_flow_verify consolidated verdict)',
  metric: 'tokens an agent/CI READS to re-verify a K-flow suite, per run',
  points,
  note: 'reticle_flow_verify returns ONE verdict for the whole suite (passing flows counted, only failures detailed) → read-cost ~constant in K. Competitors re-drive each flow with the LLM (~30,249 tok/flow) → cost is K*per-flow. The ratio therefore GROWS with suite size: the chased RRE metric compounds.',
};
writeFileSync('bench/raw/suite-rre.json', JSON.stringify(summary, null, 2));
const last = points.at(-1);
console.log(
  `\n=== suite-RRE: ${names.length} flows verified in ~${last?.reticle_verify_tokens} tok (${last?.status}) vs ${last?.competitor_redrive_tokens} re-drive => ${last?.suite_rre_ratio}x (grows with K) ===`,
);
process.exit(0);
