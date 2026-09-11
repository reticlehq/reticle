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
// Playwright *MCP* per-flow re-drive by an LLM (Layer B, authoritative usage) — NOT `npx playwright test`.
// This distinction is the whole meaning of the ratio and is the easiest thing in this repo to quote
// dishonestly: a company that already owns a compiled Playwright suite re-runs it for ZERO tokens, so
// against THEM the ratio below is not 2574x, it is undefined. The ratio answers "cheaper than an agent
// re-driving the browser every run", and only that.
const LLM_REDRIVE_PER_FLOW = 30249;

// Self-contained golden-path flows (each includes login), recorded once and saved to .reticle/flows/.
//
// EVERY flow carries a success oracle, and that is not decoration. A flow that asserts no observable
// consequence replays green whatever the app does, so `flow_verify` grades the whole suite
// `unverifiable` and refuses to call it passed — correctly. This harness used to record four
// assertion-free flows and then demand `status === 'pass'`, which made `pnpm bench` fail outright:
// the product got more honest about false greens and the benchmark measuring it did not follow.
// A suite-scale efficiency ratio over a suite that verified nothing is exactly the number this
// harness already refuses to print.
const FLOWS = [
  {
    name: 'suite-500',
    steps: [{ view: 'diagnostics' }, { tap: 'fault-500' }],
    oracle: { signal: 'fault:injected' },
  },
  {
    name: 'suite-shape',
    steps: [{ view: 'diagnostics' }, { tap: 'fault-wrong-data' }],
    oracle: { signal: 'fault:injected' },
  },
  { name: 'suite-route', steps: [{ view: 'compose' }], oracle: { testid: 'compose-generate' } },
  {
    name: 'suite-404',
    steps: [{ view: 'diagnostics' }, { tap: 'fault-404' }],
    oracle: { signal: 'fault:injected' },
  },
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
    await a.c.callTool('reticle_record', { action: 'start', recordingName: flow.name });
    for (const s of flow.steps) {
      if (s.view) await a.gotoView(s.view);
      else if (s.tap) await a.clickTestid(s.tap);
      await sleep(200);
    }
    // Compile the golden end-condition into the recording BEFORE stopping it — annotate targets the
    // active recording, and flow_save folds it onto disk.
    const ann = await a.c.callTool('reticle_annotate', {
      flow: flow.name,
      kind: 'success-state',
      ...flow.oracle,
    });
    const compiled = JSON.parse(ann.text || '{}').compiled ?? null;
    if (null === compiled) {
      throw new Error(
        `annotate did not compile a success oracle for ${flow.name} (${ann.text ?? 'no reply'}) — ` +
          'the flow would be saved assertion-free and grade the whole suite unverifiable.',
      );
    }
    await a.c.callTool('reticle_record', { action: 'stop', recordingName: flow.name });
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
    const res = await a.c.callTool('reticle_verify', { action: 'flows', names });
    const text = res.text || '';
    let obj = {};
    try {
      obj = JSON.parse(text);
    } catch {
      /* leave empty */
    }
    // `passed`/`total` are read by the caller's "did this suite actually verify" guard. They were not
    // returned, so that guard compared `undefined !== k` and threw on every run — including runs where
    // the suite verified perfectly (status=pass). A guard that cannot pass is not a guard.
    return {
      tokens: measure(text).tokens_o200k,
      status: obj.status ?? 'unknown',
      passed: obj.passed,
      total: obj.total,
      verdict: obj,
    };
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
  // A ratio over a FAILING verify is not a measurement. This harness happily printed "474x" from a
  // run in which every flow failed to replay (status=fail, passed=0) because the tool names it called
  // had been consolidated away — the cost of a failed verify is still a number, and a number still
  // divides. Efficiency is only meaningful when the thing was actually verified.
  if (v.status !== 'pass' || v.passed !== k) {
    throw new Error(
      `suite verify did not pass at K=${k} (status=${v.status}, passed=${v.passed}/${k}). ` +
        'Refusing to report a regression-efficiency ratio for a suite that did not verify.',
    );
  }
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
