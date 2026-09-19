// What the harness costs to drive, with a frontier model and with a System One model.
//
// This is the real one. Both arms drive apps/bench-app through the SAME MCP surface, the same
// `reticle_verify { action: "explore" }` tool and the same loop; the only thing that differs is
// which `ModelDriver` the daemon builds, selected by RETICLE_HARNESS_DRIVER. So the comparison is
// the driver and nothing else.
//
//   anthropic  server/src/features/harness/driver.ts  — generates tool calls as text
//   jev        server/src/features/harness/jev-driver.ts — picks one of the calls we enumerated
//
// WHAT IS AND IS NOT COMPARABLE HERE
//
// Tokens are NOT comparable across the arms and are deliberately not summed into one number. The
// two models price different things — Anthropic bills input+output with a cache tier, Jev bills
// input only and gives output away — so a single "tokens" column would be three different units
// stacked. Dollars are the comparable column, and they are computed from each provider's published
// price, which is recorded in the output so a stale price is visible rather than silent.
//
// The column that decides anything, though, is neither: it is `flows`. A drive that costs nothing
// and records nothing is worth nothing, because a saved flow is the entire product of an explore —
// it replays deterministically forever with no model in the loop. An arm that is cheaper and saves
// fewer flows has not won, and the scorecard must not let it look like it has.
//
// REQUIRES: apps/api on :8787 and apps/bench-app on :4312, plus a key per arm. Missing key ⇒ that
// arm reports NOT MEASURED and the run continues; missing fixtures ⇒ it refuses outright, because
// a drive against a page that is not there produces a clean-looking zero.
//
//   ANTHROPIC_API_KEY=... JEV_API_KEY=... node bench/harness/jev-vs-llm.mjs
//   node bench/harness/jev-vs-llm.mjs --only jev
//
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { McpStdioClient } from './mcp-client.mjs';
import { RETICLE_PORT } from './ports.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const API_HEALTH = process.env.BENCH_API_HEALTH ?? 'http://localhost:8787/api/health';
const OUT = 'bench/raw/jev-vs-llm.json';
const MAX_STEPS = process.env.BENCH_MAX_STEPS ?? '24';

/** Published list prices, $ per million tokens. Recorded in the output so a stale one is visible. */
const PRICE = {
  // claude-sonnet-5, the harness default (DEFAULT_HARNESS_MODEL).
  anthropic: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // jev-latest. Output is free, which is why it is zero here rather than absent.
  jev: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const FOCUS =
  'Sign in with admin@reticle.dev / password, then move through the product the way somebody using ' +
  'it would: open the main sections, submit a form, and follow where it takes you.';

const ARMS = {
  anthropic: {
    key: 'ANTHROPIC_API_KEY',
    env: () => ({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '' }),
  },
  jev: {
    key: 'JEV_API_KEY',
    env: () => ({ JEV_API_KEY: process.env.JEV_API_KEY ?? '', RETICLE_HARNESS_DRIVER: 'jev' }),
  },
};

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;
const usd = (usage, price) =>
  ((usage.input ?? 0) * price.input +
    (usage.output ?? 0) * price.output +
    (usage.cacheRead ?? 0) * price.cacheRead +
    (usage.cacheWrite ?? 0) * price.cacheWrite) /
  1_000_000;

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/**
 * Make sure no daemon is already holding the bench port, and explain why that matters.
 *
 * `reticle mcp --port N` ATTACHES to whatever daemon already holds N, and a daemon reads its driver
 * and its step budget from the environment exactly once, when it starts. So a daemon left over from
 * an earlier run serves every later arm with the earlier run's configuration. That is not a
 * hypothesis: three runs of this bench reported `steps: 24` — including one where the budget was set
 * to 8 — because all three were answered by the first run's daemon. Nothing errored and every row
 * said MEASURED.
 *
 * The port cannot simply be randomised: apps/bench-app bakes the port its SDK dials into the bundle
 * when vite starts, so a daemon anywhere else is a daemon the app never connects to, and the drive
 * would run against a page with no session.
 *
 * `-sTCP:LISTEN` is load-bearing. Without it this matches `reticle mcp` proxies too — including the
 * caller's own editor session — and killing those is the single most common cause of a "Reticle MCP
 * disconnected" that has nothing to do with Reticle.
 */
function clearDaemon(port) {
  let pids = '';
  try {
    pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return; // lsof exits non-zero when nothing matches, which is the ordinary case.
  }
  for (const pid of pids.split('\n').filter(Boolean)) {
    try {
      process.kill(Number(pid));
      console.error(`  cleared a daemon already listening on ${port} (pid ${pid})`);
    } catch {
      /* already gone */
    }
  }
}

/**
 * One arm: a fresh daemon on a port of its own, a fresh browser, one explore, torn down.
 *
 * The daemon is spawned per arm rather than reused, because the driver is chosen from the
 * environment when the daemon builds it — a reused daemon would run the second arm with the first
 * arm's driver and report two rows for one configuration.
 */
async function runArm(name) {
  const arm = ARMS[name];
  if (!process.env[arm.key]) {
    return {
      arm: name,
      status: 'NOT MEASURED',
      reason: `${arm.key} not set; this arm puts a real model in the loop.`,
    };
  }

  const port = RETICLE_PORT;
  clearDaemon(port);
  const client = new McpStdioClient(
    'node',
    ['server/dist/command/cli.js', 'mcp', '--port', port, '--drive', URL],
    { RETICLE_PORT: port, RETICLE_HARNESS_MAX_STEPS: MAX_STEPS, ...arm.env() },
  );

  const startedAt = Date.now();
  try {
    await client.start();
    // The SDK in the driven page needs a moment to dial the bridge. Explore against a session that
    // has not connected drives nothing and returns a clean-looking zero, which is the one result
    // shape this bench must never produce by accident.
    await new Promise((r) => setTimeout(r, 4000));

    const raw = await client.callTool(
      'reticle_verify',
      { action: 'explore', persona: FOCUS },
      600_000,
    );
    // `result.content`, not `content`: the client hands back the whole JSON-RPC envelope. Reading the
    // wrong level returned `{}` for a drive that had really run 24 steps, and the row said MEASURED
    // over it — a clean-looking zero, which is the exact shape this file's header promises to refuse.
    const text = raw?.result?.content?.[0]?.text ?? raw?.content?.[0]?.text;
    if (text === undefined)
      throw new Error(`no tool output to read: ${JSON.stringify(raw).slice(0, 300)}`);
    const result = JSON.parse(text);
    const usage = result.usage ?? {};
    // A drive with no steps is not a measurement of a cheap driver; it is a driver that never ran.
    if (!(0 < (result.steps ?? 0)))
      throw new Error(`the drive took no steps: ${JSON.stringify(result).slice(0, 300)}`);
    const price = PRICE[name];

    return {
      arm: name,
      status: 'MEASURED',
      wall_ms: Date.now() - startedAt,
      port,
      stop_reason: result.stopReason ?? null,
      steps: result.steps ?? 0,
      // The budget this arm was actually given. Printed because the run that made this bench
      // trustworthy was the one where `steps` did not move when this did.
      max_steps: Number(MAX_STEPS),
      // The product of the drive. A cheap arm that saves none of these has not won anything.
      // New names plus rewrites. A second run re-drives the same journeys under the same names, so
      // counting only new names scores the identical drive as worthless the second time it happens.
      flows: (result.savedFlows ?? []).length + (result.rewroteFlows ?? []).length,
      flow_names: [...(result.savedFlows ?? []), ...(result.rewroteFlows ?? [])],
      usage,
      price_per_mtok: price,
      usd: Number(usd(usage, price).toFixed(6)),
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.note === undefined ? {} : { note: result.note }),
    };
  } catch (error) {
    return { arm: name, status: 'NOT MEASURED', reason: String(error?.message ?? error) };
  } finally {
    await client.stop().catch(() => {});
  }
}

if (!(await up(API_HEALTH)) || !(await up(URL))) {
  console.error(
    `fixtures are not up. Needs apps/api (${API_HEALTH}) and apps/bench-app (${URL}).\n` +
      `  node apps/api/server.mjs &\n` +
      `  RETICLE_PORT=${RETICLE_PORT} pnpm --filter @reticlehq/bench-app exec vite --port 4312 --strictPort &`,
  );
  process.exit(1);
}

const names = null === only ? Object.keys(ARMS) : [only];
const rows = [];
for (const name of names) {
  console.error(`driving: ${name}…`);
  const row = await runArm(name);
  rows.push(row);
  console.error(`  ${JSON.stringify(row)}`);
}

const measured = rows.filter((r) => 'MEASURED' === r.status);
const out = {
  bench: 'jev-vs-llm',
  at: new Date().toISOString(),
  url: URL,
  max_steps: Number(MAX_STEPS),
  focus: FOCUS,
  note: 'Same app, same tools, same loop; only the ModelDriver differs. Tokens are NOT comparable across arms (different billing units) — dollars and flows are.',
  rows,
  ...(2 === measured.length
    ? {
        comparison: {
          usd_ratio_anthropic_over_jev: Number(
            (
              (measured.find((r) => 'anthropic' === r.arm)?.usd ?? 0) /
              Math.max(measured.find((r) => 'jev' === r.arm)?.usd ?? 0, 1e-9)
            ).toFixed(1),
          ),
          wall_ratio_anthropic_over_jev: Number(
            (
              (measured.find((r) => 'anthropic' === r.arm)?.wall_ms ?? 0) /
              Math.max(measured.find((r) => 'jev' === r.arm)?.wall_ms ?? 1, 1)
            ).toFixed(2),
          ),
        },
      }
    : {}),
};

mkdirSync('bench/raw', { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
console.error(`\nwrote ${OUT}`);
