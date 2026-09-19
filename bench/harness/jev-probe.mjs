// Does a System One model have the shape the harness driver needs? Three probes, no app required.
//
// This is the DE-RISK, not the benchmark. The benchmark (jev-vs-llm) drives the real bench-app
// through the real MCP surface and is the only thing that may be quoted as a result. This file
// answers a narrower question that has to be true before that one is worth running at all:
//
//   P1  batching     — does asking N questions cost about the same as asking one?
//   P2  discrimination — can it pick one action out of a large, deliberately noisy candidate set?
//   P3  completion   — can it drive a scripted app to a goal and know that it arrived?
//
// P3 runs against a hard-coded state machine, NOT a browser. That is the point: it isolates the
// model's choosing from every other moving part in this repo. A pass here says the design is worth
// building; it says nothing about the real thing, and nobody may quote it as if it did.
//
//   JEV_API_KEY=... node bench/harness/jev-probe.mjs
//
import { writeFileSync, mkdirSync } from 'node:fs';
import { askJev, jevCostUsd } from './jev.mjs';

const OUT = 'bench/raw/jev-probe.json';

if (!process.env.JEV_API_KEY) {
  console.log(
    JSON.stringify(
      {
        probe: 'jev',
        status: 'NOT MEASURED',
        reason:
          'JEV_API_KEY not set. Every probe here is a live API call; without a key there is nothing to measure and nothing is fabricated.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const ask = (state, questions) => askJev({ state, questions });
const topN = (probabilities, n) =>
  Object.entries(probabilities ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([option, p]) => ({ option, p }));

// ── P1 · batching ────────────────────────────────────────────────────────────────────────────────
// The claim is that the cost is the STATE, not the questions. If that is false the driver has to
// split its decisions across calls and the whole latency argument collapses, so it is measured first.
async function probeBatching() {
  const rows = Array.from(
    { length: 220 },
    (_, i) => `[e${i}] <button data-reticle-source="src/Row.tsx:${i}"> Row ${i} action </button>`,
  ).join('\n');
  const state =
    `INTENT: clicking 'Checkout' shows an order confirmation carrying an order id.\n` +
    `PAGE SNAPSHOT AFTER ACTION:\n${rows}\n` +
    `NETWORK: POST /api/order -> 201 {orderId:'ord_81'}\nCONSOLE: (empty)\n` +
    `ROUTE: /checkout -> /orders/ord_81\nDOM DIFF: +div.confirmation 'Order ord_81 confirmed'`;

  const battery = {
    consequence_happened: {
      type: 'noul',
      instructions: 'The stated intended consequence actually occurred in the observed evidence.',
    },
    capture_clean: {
      type: 'noul',
      instructions: 'The evidence is complete and settled rather than truncated or mid-flight.',
    },
    is_false_green: {
      type: 'noul',
      instructions:
        'The evidence only describes what should happen rather than showing that it did.',
    },
    app_errored: {
      type: 'noul',
      instructions: 'The application logged an error or a network request failed.',
    },
    drive_done: {
      type: 'noul',
      instructions: 'Enough has been observed to decide; no further action is needed.',
    },
    verdict: {
      type: 'choice',
      instructions: 'The verification verdict for the stated intent.',
      criteria: {
        pass: 'Proven to have happened',
        fail: 'Proven not to have happened',
        unknown: 'Insufficient evidence',
      },
    },
    severity: {
      type: 'score',
      instructions: 'How badly any defect affects the user.',
      criteria: ['Nothing is wrong', 'Cosmetic', 'Blocks the user'],
    },
  };

  const entries = Object.entries(battery);

  /**
   * Counts are measured INTERLEAVED and repeated, then reduced to a median.
   *
   * Run once each in ascending order, this probe reported seven questions at 0.3x the latency of one
   * — a number that reads as a spectacular argument for batching and is really an argument for a warm
   * socket, since the 1-question call went first and paid for the connection. Discarding a single
   * warm-up call did not fix it; the first two were still visibly climbing. Interleaving does, because
   * the warm-up is then shared by every arm instead of donated to whichever one ran first.
   */
  const COUNTS = [1, 3, 7];
  const REPEATS = 4;
  const samples = new Map(COUNTS.map((n) => [n, []]));
  await ask(state, Object.fromEntries(entries.slice(0, 1))); // open the connection, measure nothing
  for (let round = 0; round < REPEATS; round++) {
    for (const n of COUNTS) {
      const res = await ask(state, Object.fromEntries(entries.slice(0, n)));
      samples
        .get(n)
        .push({ ms: res.ms, input_tokens: res.usage.input_tokens, usd: jevCostUsd(res.usage) });
    }
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const measurements = COUNTS.map((n) => {
    const got = samples.get(n);
    return {
      questions: n,
      repeats: got.length,
      ms_median: median(got.map((s) => s.ms)),
      ms_all: got.map((s) => s.ms),
      input_tokens: got[0].input_tokens,
      usd: got[0].usd,
    };
  });

  const one = measurements[0];
  const seven = measurements[measurements.length - 1];
  return {
    state_chars: state.length,
    measurements,
    /**
     * The load-bearing claim, and the only one here that is a property of the MODEL rather than of
     * this laptop's network: seven questions cost ~1.03x the tokens of one, because the price is the
     * state and the state is identical. The latency ratio is reported beside it for honesty, but it
     * is noisy at this sample size and must not be quoted as a speedup — nothing gets FASTER by being
     * asked more, and a ratio below 1.0 here means the sampling is still dirty, not that it did.
     */
    token_ratio_7_over_1: Number((seven.input_tokens / one.input_tokens).toFixed(3)),
    ms_median_ratio_7_over_1: Number((seven.ms_median / one.ms_median).toFixed(2)),
  };
}

// ── P2 · discrimination ──────────────────────────────────────────────────────────────────────────
// A real page is mostly noise. 36 plausible-but-wrong row links surround the one right button; the
// driver's whole premise is that the right one can be picked out of that without generating anything.
async function probeDiscrimination() {
  const noise = Array.from({ length: 36 }, (_, i) => [
    `act:n${i}`,
    `Click the "deploy-svc-${i}" row link`,
  ]);
  const criteria = Object.fromEntries([
    ...noise,
    ['act:e5', "Click the 'New deployment' button"],
    ['act:e4', "Click 'Sign out'"],
    ['act:e2', "Click the 'Deployments' nav link"],
    ['act:e7', "Click the 'Refresh' button"],
    ['fill:e6', "Type into the 'Search deployments' input"],
    ['look:page', 'Re-read the page snapshot without acting'],
    ['observe:network', 'Read network activity'],
    ['finish', 'Stop: the goal is already achieved'],
  ]);
  const state =
    `GOAL: Create a new deployment and confirm it appears in the list.\n` +
    `CURRENT PAGE: dashboard, 44 interactive elements, 36 of them existing deployment rows.\n` +
    `NETWORK: GET /api/deployments -> 200 (36 items)\nCONSOLE: (empty)`;

  const res = await ask(state, {
    next_action: {
      type: 'choice',
      instructions: 'Which single action best advances the stated GOAL from the current page?',
      criteria,
    },
  });
  const answer = res.answers.next_action;
  return {
    candidates: Object.keys(criteria).length,
    expected: 'act:e5',
    chose: answer.choice,
    correct: 'act:e5' === answer.choice,
    confidence: answer.confidence,
    top3: topN(answer.probabilities, 3),
    ms: res.ms,
    input_tokens: res.usage.input_tokens,
  };
}

// ── P3 · completion ──────────────────────────────────────────────────────────────────────────────
/**
 * A scripted app, deliberately tiny.
 *
 * Every transition is hard-coded, so the ONLY thing under test is which action gets chosen. The
 * shortest correct path is 4 steps; anything longer means the model wandered, and `finish` on any
 * state before `created` means it declared success it had not seen.
 */
const APP = {
  dashboard: {
    snap: '[e2] link "Deployments"\n[e5] button "New deployment"\n[e4] button "Sign out"',
    acts: { 'act:e5': 'form', 'act:e2': 'dashboard', 'act:e4': 'loggedout' },
  },
  form: {
    snap: '[f1] input "Service name" (empty)\n[f2] select "Region" (us-east)\n[f3] button "Create" (disabled)\n[f4] button "Cancel"',
    acts: { 'fill:f1': 'formfilled', 'act:f4': 'dashboard', 'act:f3': 'form' },
  },
  formfilled: {
    snap: '[f1] input "Service name" ("benchmark-svc")\n[f2] select "Region" (us-east)\n[f3] button "Create" (enabled)\n[f4] button "Cancel"',
    acts: { 'act:f3': 'created', 'act:f4': 'dashboard' },
  },
  created: {
    snap: '[e2] link "Deployments"\n[e5] button "New deployment"\n[d9] link "benchmark-svc" (status: running)',
    acts: { 'act:d9': 'detail' },
    net: "POST /api/deployments -> 201 {id:'dep_9',name:'benchmark-svc'}",
  },
  detail: {
    snap: '[b1] button "Back"\ntext: "benchmark-svc — running"',
    acts: { 'act:b1': 'created' },
  },
};
const GOAL =
  "Create a new deployment named 'benchmark-svc' and confirm it appears in the deployment list.";
const OPTIMAL_STEPS = 4;
const MAX_STEPS = 8;

async function probeCompletion() {
  let current = 'dashboard';
  const log = [];
  const steps = [];
  let inputTokens = 0;
  let ms = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const node = APP[current];
    const criteria = {
      ...Object.fromEntries(
        Object.keys(node.acts).map((k) => [
          k,
          k.startsWith('fill')
            ? `Type the service name into ${k.split(':')[1]}`
            : `Click ${k.split(':')[1]}`,
        ]),
      ),
      finish: 'Stop: the GOAL is fully achieved and confirmed',
    };
    const state =
      `GOAL: ${GOAL}\nSTEPS SO FAR:\n${log.map((l, i) => ` ${i + 1}. ${l}`).join('\n') || ' (none)'}\n` +
      `CURRENT PAGE SNAPSHOT:\n${node.snap}\nNETWORK since last step: ${node.net ?? '(none)'}\nCONSOLE: (empty)`;

    const res = await ask(state, {
      next_action: {
        type: 'choice',
        instructions: 'Which single action best advances the stated GOAL from the current page?',
        criteria,
      },
      goal_achieved: {
        type: 'noul',
        instructions:
          'The stated GOAL has been fully achieved AND confirmed by the observed evidence.',
      },
    });
    inputTokens += res.usage.input_tokens;
    ms += res.ms;
    const chose = res.answers.next_action.choice;
    steps.push({
      at: current,
      chose,
      confidence: res.answers.next_action.confidence,
      goal_achieved: res.answers.goal_achieved.noul,
      ms: res.ms,
    });
    if ('finish' === chose) break;
    log.push(`${chose} on ${current}`);
    current = node.acts[chose] ?? current;
  }

  const last = steps[steps.length - 1];
  return {
    steps,
    step_count: steps.length,
    optimal_steps: OPTIMAL_STEPS,
    took_optimal_path: steps.length === OPTIMAL_STEPS,
    ended_at: current,
    // Finishing anywhere but `created`/`detail` is a false green: success declared without the
    // confirmation the goal explicitly asked for.
    finished_honestly: 'finish' === last?.chose && ('created' === current || 'detail' === current),
    input_tokens: inputTokens,
    ms,
    usd: jevCostUsd({ input_tokens: inputTokens }),
  };
}

const out = {
  probe: 'jev',
  status: 'MEASURED',
  at: new Date().toISOString(),
  note: 'De-risk only. P3 drives a scripted state machine, not a browser; it may not be quoted as a benchmark result.',
  batching: await probeBatching(),
  discrimination: await probeDiscrimination(),
  completion: await probeCompletion(),
};

mkdirSync('bench/raw', { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
console.error(`\nwrote ${OUT}`);
