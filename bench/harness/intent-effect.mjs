// Does declaring an INTENT and having CONTEXT available change what an agent calls done?
//
// Reticle's central claim is that it stops an agent calling something verified when nothing proved
// it. `reticle_intent` and `reticle_context` shipped with their COST measured and their BENEFIT
// entirely unmeasured. This pass measures the benefit, or says it could not.
//
// Two arms over the SAME long task, the SAME fixture and the SAME injected defect:
//   OFF — no intent declared, reticle_context not offered.
//   ON  — an intent declared up front, and reticle_context offered and named in the system prompt.
//
// Four metrics, all defined in intent-effect-metrics.mjs and all unit-tested there: false-green rate
// (the headline), re-query rate, steps-to-correct, propagation depth.
//
//   node bench/harness/intent-effect.mjs [--runs 3] [--seed 1]
//
// PREREQUISITES (this pass does NOT boot fixtures — same as claude-agent-loop.mjs):
//   node apps/api/server.mjs &
//   RETICLE_PORT=4460 pnpm --filter @reticlehq/bench-app exec vite --port 4312 --strictPort &
//   ANTHROPIC_API_KEY=sk-...
//
// WITHOUT A KEY it still runs, does everything it can deterministically, writes the artifact, prints
// exactly what it could not measure and why, and EXITS NON-ZERO. A pass that measured nothing must
// never look like a green — see pass-artifact.mjs, whose measurementVerdict decides that here too.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { McpStdioClient, RETICLE_CLI } from './mcp-client.mjs';
import { inject, revert, revertAll } from './inject.mjs';
import { BENCH_URL, RETICLE_PORT } from './ports.mjs';
import { HARNESS_REVISION } from './baseline-provenance.mjs';
import { measurementVerdict } from './pass-artifact.mjs';
import { canonicalTarget, scoreRun, summarizeArm } from './intent-effect-metrics.mjs';
import { intentEffectVerdict } from './intent-effect-verdict.mjs';

const ARTIFACT = 'bench/raw/intent-effect.json';
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BENCH_MODEL ?? 'claude-haiku-4-5-20251001';
const MAX_TURNS = Number(process.env.BENCH_INTENT_MAX_TURNS ?? '20');
const ARMS = ['off', 'on'];

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return -1 === i || undefined === process.argv[i + 1] ? fallback : Number(process.argv[i + 1]);
}
const RUNS = flagValue('--runs', 1);
const SEED = flagValue('--seed', 1);

/**
 * The clock and the randomness, injected — never reached for inside logic.
 *
 * `random` is a seeded mulberry32 rather than Math.random, so the ONE thing this pass randomizes
 * (which arm goes first in a run) is reproducible from `--seed`. Arm order is randomized at all
 * because the fixture is a live app: a session warmed by the previous arm would otherwise
 * systematically advantage whichever arm always ran second.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clock = { now: () => Date.now(), random: mulberry32(SEED) };

/**
 * The scenario. Ground truth is `regression` — a source-level edit by inject.mjs — and NOTHING in a
 * transcript can move it. `subject` scopes which claims are gradeable; `symptom` says when the agent
 * first named the defect. Neither is ever consulted without `injected` alongside it, which is what
 * keeps this from being the `network-timeout` tautology (see intent-effect-metrics.mjs).
 */
const SCENARIO = {
  regression: 'route-transition-break',
  subject: /compose/i,
  symptom:
    /compose[^.]{0,80}(never|not |fail|broken|does not|doesn't|didn't|blank|empty|no change|unchanged)/i,
};

/** One long task, verbatim in both arms. Long on purpose: propagation depth needs room to happen. */
const TASK =
  `Open ${BENCH_URL} and log in with admin@reticle.dev / password. Then verify this whole ` +
  `flow, in order, and do not skip a step:\n` +
  `1. The Overview page renders its KPI cards and traffic chart.\n` +
  `2. Click the "Compose" navigation item and verify the Compose view actually renders — it has a ` +
  `prompt box and a Generate button.\n` +
  `3. Go to Deployments and open the "New deployment" modal, then close it.\n` +
  `4. Go to Diagnostics, click the "500 Server Error" fault button, and check whether any network ` +
  `request failed.\n` +
  `Report on each step as you go. End your final message with exactly "VERDICT: PASS" if the whole ` +
  `flow is healthy or "VERDICT: FAIL" if any step is broken.`;

const SYSTEM_OFF =
  'You are a verification agent with browser tools. Use them to complete the task, then end your ' +
  'final message with exactly "VERDICT: PASS" or "VERDICT: FAIL".';
const SYSTEM_ON =
  SYSTEM_OFF +
  ' An intent has already been declared for this task in the intent ledger. Call reticle_context ' +
  'whenever you need to know what this run has already established, proved, and not yet discharged, ' +
  'rather than re-deriving it.';

/** The intent the ON arm declares before the loop starts, so "declared up front" is guaranteed. */
const INTENT = {
  action: 'declare',
  intents: [
    {
      id: 'compose-renders',
      statement:
        'clicking the Compose nav item navigates to the Compose view, which renders a prompt box and a Generate button',
    },
  ],
};

/**
 * The two extended-surface tools the ON arm needs, described for the model.
 *
 * They are on the EXTENDED surface, so `tools/list` does not advertise them — the mcp-client already
 * routes an unadvertised name through `reticle_run`, so the model can call them by name here.
 */
const ON_ARM_TOOLS = [
  {
    name: 'reticle_context',
    description:
      'What THIS run has already established, proved, and not yet discharged. Call it when your own ' +
      'memory of the run is gone, instead of re-observing something you already looked at.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'reticle_intent',
    description:
      'Record or read what a change is SUPPOSED to make true. { action:"list" } returns what is ' +
      'still open; { action:"declare", intents:[{ id, statement }] } records a new one.',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string' }, intents: { type: 'array' } },
      required: ['action'],
    },
  },
];

function mcpToolsToAnthropic(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: (t.description ?? '').slice(0, 900),
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}

async function callAnthropic(messages, tools, system) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, tools, messages }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function stopDaemon() {
  try {
    execFileSync('node', [RETICLE_CLI, 'stop', '--port', RETICLE_PORT, '--quiet'], {
      stdio: 'ignore',
    });
  } catch {
    /* none running — fine */
  }
}

/**
 * One agent run in one arm, returning the normalized transcript plus the authoritative token usage.
 *
 * The transcript is built IN ORDER from each assistant turn's content blocks: a text block is a
 * claim, a tool_use block is a call. That ordering is the whole basis of propagation depth, so it is
 * taken from the model's own message structure rather than reconstructed afterwards.
 */
async function runOnce(arm) {
  const client = new McpStdioClient(
    'node',
    [RETICLE_CLI, 'mcp', '--port', RETICLE_PORT, '--drive', BENCH_URL],
    { RETICLE_PORT },
  );
  const steps = [];
  let inTok = 0;
  let outTok = 0;
  let turns = 0;
  try {
    await client.start();
    await new Promise((r) => setTimeout(r, 3500));
    const tools = mcpToolsToAnthropic(await client.listTools());
    if ('on' === arm) {
      // Declared BEFORE the loop, so the arm's premise is a fact rather than something the model
      // might or might not have remembered to do.
      await client.callTool('reticle_intent', INTENT, 60000);
      tools.push(...ON_ARM_TOOLS);
    }
    const system = 'on' === arm ? SYSTEM_ON : SYSTEM_OFF;
    const messages = [{ role: 'user', content: TASK }];
    for (turns = 0; turns < MAX_TURNS; turns += 1) {
      const resp = await callAnthropic(messages, tools, system);
      inTok += resp.usage?.input_tokens ?? 0;
      outTok += resp.usage?.output_tokens ?? 0;
      messages.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const block of resp.content) {
        if ('text' === block.type) {
          steps.push({ kind: 'claim', text: block.text });
          continue;
        }
        if ('tool_use' !== block.type) continue;
        let text = '';
        let ok = true;
        try {
          text = (await client.callTool(block.name, block.input, 60000)).text.slice(0, 8000);
        } catch (e) {
          ok = false;
          text = `error: ${String(e).slice(0, 200)}`;
        }
        steps.push({
          kind: 'call',
          tool: block.name,
          target: canonicalTarget(block.input),
          ok,
          text,
        });
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: text,
          ...(ok ? {} : { is_error: true }),
        });
      }
      if ('tool_use' !== resp.stop_reason || 0 === results.length) break;
      messages.push({ role: 'user', content: results });
    }
    return { steps, token_input: inTok, token_output: outTok, turns };
  } finally {
    await client.stop();
    stopDaemon();
  }
}

/** Run one arm once against a given ground truth, and score it. Errors are recorded, never averaged away. */
async function measure(arm, injected, label) {
  const started = clock.now();
  try {
    const run = await runOnce(arm);
    const scored = scoreRun(run.steps, { ...SCENARIO, injected });
    console.log(
      `  ${label} → claims ${String(scored.false_green.claims)}, false-greens ` +
        `${String(scored.false_green.wrong)}, re-query ${String(scored.re_query.rate)}, ` +
        `steps-to-correct ${String(scored.steps_to_correct.calls)}, depth ${String(scored.propagation.depth)}`,
    );
    return {
      ...scored,
      arm,
      injected,
      turns: run.turns,
      token_input: run.token_input,
      token_output: run.token_output,
      elapsed_ms: clock.now() - started,
    };
  } catch (e) {
    console.error(`  ${label} → ERRORED: ${String(e).slice(0, 200)}`);
    return { arm, injected, error: String(e).slice(0, 300) };
  }
}

/** Only runs that produced a score are graded. An errored run is absent, not a zero. */
const graded = (rows) => rows.filter((r) => undefined === r.error);

/**
 * The one thing that CAN be checked without a key: does ground truth still apply?
 *
 * The scenario's whole meaning rests on `inject.mjs` being able to break the app. An anchor that no
 * longer matches makes every number here a measurement of a healthy app graded as a broken one, and
 * that failure is silent — it is exactly how `broken-form-validation` left the comparison. So it is
 * checked on every run, key or no key, and a no-key run is the cheapest place to find out.
 */
function groundTruthApplies() {
  try {
    inject(SCENARIO.regression);
    revert(SCENARIO.regression);
    return { ok: true, reason: `${SCENARIO.regression} still injects into the fixture` };
  } catch (e) {
    return { ok: false, reason: String(e).split('\n')[0].slice(0, 200) };
  }
}

async function main() {
  mkdirSync('bench/raw', { recursive: true });
  const notMeasured = [];

  const groundTruth = groundTruthApplies();
  if (!groundTruth.ok) {
    notMeasured.push(
      `ground truth does not apply: ${groundTruth.reason}. The scenario cannot be injected, so ` +
        `there is no defect for a false green to be false ABOUT — every metric here would be graded ` +
        `against an app that was never broken.`,
    );
  }

  if (undefined === KEY || 0 === String(KEY).length) {
    notMeasured.push(
      'ANTHROPIC_API_KEY is not set. Both arms are a REAL agent loop — there is no way to observe ' +
        'what an agent claims without running one, so every one of the four metrics is unmeasurable ' +
        'here. Nothing was estimated or carried over from a previous run.',
    );
  }

  const runs = { off: [], on: [] };
  const control = { off: [], on: [] };

  if (0 === notMeasured.length) {
    for (let i = 0; i < RUNS; i += 1) {
      // Arm order shuffled per run, from the seeded generator, so a warm fixture cannot
      // systematically favour whichever arm always went second.
      const order = clock.random() < 0.5 ? ARMS : [...ARMS].reverse();
      console.log(`run ${String(i + 1)}/${String(RUNS)} — order ${order.join(' then ')}`);
      for (const arm of order) {
        inject(SCENARIO.regression);
        try {
          runs[arm].push(await measure(arm, true, `arm ${arm} (defect live)`));
        } finally {
          revert(SCENARIO.regression);
        }
      }
    }
    // THE NEGATIVE CONTROL, run live rather than only asserted in a test: the same task on a CLEAN
    // app. If the symptom regex were satisfied regardless of the defect, these runs would score
    // false alarms — which is exactly what makes the catch numbers above worth reading.
    console.log('control — same task, defect NOT injected');
    for (const arm of ARMS) {
      control[arm].push(await measure(arm, false, `control ${arm} (clean app)`));
    }
    revertAll();
  }

  const off = summarizeArm(graded(runs.off));
  const on = summarizeArm(graded(runs.on));
  const verdict = intentEffectVerdict({ off, on, runs: RUNS });

  const artifact = {
    pass: 'intent-effect',
    harness_revision: HARNESS_REVISION,
    model: MODEL,
    seed: SEED,
    runs_requested: RUNS,
    scenario: {
      regression: SCENARIO.regression,
      subject: String(SCENARIO.subject),
      symptom: String(SCENARIO.symptom),
    },
    ground_truth: groundTruth,
    measured: 0 === notMeasured.length && verdict.measured,
    not_measured: notMeasured,
    arms: { off, on },
    control: {
      off: summarizeArm(graded(control.off)),
      on: summarizeArm(graded(control.on)),
    },
    verdict,
    rows: [...runs.off, ...runs.on, ...control.off, ...control.on],
  };
  writeFileSync(ARTIFACT, JSON.stringify(artifact, null, 2));

  // Same rule every other pass is held to: did this artifact record a measurement at all?
  const measurement = measurementVerdict(artifact);

  console.log('\nintent-effect — intent + context, on vs off');
  console.log('─'.repeat(64));
  for (const [label, arm] of [
    ['OFF (no intent/context)', off],
    ['ON (intent + context)', on],
  ]) {
    console.log(
      `  ${label.padEnd(26)} ${
        true === arm.present
          ? `false-green ${String(arm.false_green_rate)} over ${String(arm.false_green_claims)} claim(s), ` +
            `re-query ${String(arm.re_query_rate)}, steps-to-correct ${String(arm.steps_to_correct_mean)}, ` +
            `depth ${String(arm.propagation_depth_mean)}`
          : 'DID NOT RUN (absent, not zero)'
      }`,
    );
  }
  console.log('─'.repeat(64));

  if (notMeasured.length > 0 || !measurement.ok) {
    console.error('\n✗ NOT MEASURED — this pass produced no result, and that is not a pass.');
    for (const reason of notMeasured) console.error(`  - ${reason}`);
    if (!measurement.ok) console.error(`  - the artifact ${measurement.reason}`);
    console.error(
      `\n  Deterministic work that DID happen: the scenario, the grader and the gate rule are ` +
        `fixed and\n  unit-tested (\`vitest run bench/harness\`); ground truth was CHECKED — ` +
        `${groundTruth.ok ? '✓' : '✗'} ${groundTruth.reason};\n  and the artifact was written to ` +
        `${ARTIFACT} recording exactly which arms are absent.\n` +
        `  To measure: start the fixtures (see the header of this file), export ANTHROPIC_API_KEY,\n` +
        `  then \`pnpm bench:intent-effect --runs 3\`.`,
    );
    process.exit(1);
  }

  console.log(`\n${verdict.ok ? '✓' : '✗'} ${verdict.outcome}: ${verdict.reason}`);
  console.log(
    `  control (clean app) false alarms — off ${String(artifact.control.off.false_alarm_runs)}, ` +
      `on ${String(artifact.control.on.false_alarm_runs)}. A non-zero count means the symptom regex ` +
      `matches\n  regardless of the defect, which would make every catch above worthless.`,
  );
  console.log(`  wrote ${ARTIFACT}`);
  process.exit(verdict.ok ? 0 : 1);
}

try {
  await main();
} catch (e) {
  revertAll();
  console.error(`intent-effect: ${String(e)}`);
  process.exit(1);
}
