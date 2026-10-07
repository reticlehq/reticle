/**
 * The Harness with no journey named: plan the drive from what the project knows, then run the plan.
 *
 * Saved flows replay in lanes side by side (each lane its own leased browser context, when the pool
 * can lease one), flows that start the same way are driven once and branched from, and the open
 * journeys (personas, the user's request, unproved intents) go to the model. The plan is drawn on
 * the HUD and redrawn as each part starts and ends.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ReticleCommand, ReticleTool, ScriptStatus, asRecord } from '@reticlehq/core';
import { PromptContextSchema, checkScript, type DriveScript } from '@reticlehq/core/artifacts';
import {
  runScript,
  type ScriptPorts,
  type ScriptRun,
} from '@/features/harness/script/script-run.js';
import { CUSTOM_DRIVER_NAME } from '@/features/harness/drivers.js';
import { checkTally, verdictLine } from '@/features/harness/drive-report.js';
import {
  runHarness,
  StopReason,
  type HarnessResult,
  type ModelDriver,
  type ToolOutcome,
} from '@/features/harness/harness.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { harnessRunId, noteHarnessGoal } from '@/judgement/runs/drive-run.js';
import { openSessionIntents } from '@/memory/intent/open-intents.js';
import { sessionRoot, sessionTarget } from '@/memory/project/session-root.js';
import { leasableAppUrl } from '@/language/flows/flow-tools.js';
import type { ToolDeps } from './tool-kit.js';
import { acquireLeasedSession } from './lease-tools.js';
import { reticleToolset } from './harness-toolset.js';
import { laneIds } from '@/features/harness/script/lane-ids.js';
import { appControlsOf } from '@/features/harness/script/app-controls.js';
import {
  PlanStepKind,
  aboutTheApp,
  planAsText,
  withoutReplays,
  type HarnessPlan,
} from './harness-plan.js';
import {
  journeyResults,
  personasIn,
  proposeScript,
  reportPlanResults,
  type JourneyResult,
} from '@/features/harness/platform/script.js';
import { checkGoals, goalsIn } from '@/features/harness/goals.js';
import { serverOptionsFromEnv } from '@/features/harness/platform/server-driver.js';
import {
  MSG_HARNESS_DISABLED,
  bankOpenRecording,
  buildDriver,
  flowsThatCheckNothing,
  maxStepsFromEnv,
  narrator,
  pinned,
  productRules,
  readFlows,
  readPlan,
  reconcileFlows,
  recordPersona,
  refusedByPlatform,
  withProjectFlows,
  type ExploreOptions,
  type ExploreResult,
} from './harness-explore.js';

/** A request older than this is about some earlier task, not the one being driven. */
const REQUEST_FRESH_MS = 6 * 60 * 60 * 1000;
const MAX_GOAL_CHARS = 500;
/**
 * Lanes at once. Each is a fresh context loading the app cold, and eight against a dev server timed
 * out together. ponytail: a fixed cap; read it from the pool's measured load time if 4 is too few.
 */
const MAX_LANES = 4;
/** How often a scripted drive asks whether autonomous driving was switched off. */
const STOP_POLL_MS = 10_000;

/**
 * The platform plans the drive; this machine runs the plan: saved flows replayed in lanes side by side, shared starts
 * driven once and branched from, open journeys handed to the model. `undefined` when there is
 * nothing to plan from, so the caller drives the app with no plan, as before.
 */
export async function exploreScript(
  deps: ToolDeps,
  env: Record<string, string | undefined>,
  options: ExploreOptions,
  before: ReadonlySet<string>,
): Promise<ExploreResult | undefined> {
  const reads = withProjectFlows(deps, options.sessionId);
  const plan = await readPlan(reads, options.sessionId);
  // A named journey is the whole plan: no other flows replayed, no personas proposed beside it.
  const focus = options.focus;
  const replay =
    focus === undefined
      ? plan.steps.filter((s) => PlanStepKind.REPLAY === s.kind).map((s) => s.target)
      : [];
  const goals = focus === undefined ? await memoryGoals(deps, options.sessionId) : [focus];
  const gaps = plan.steps.filter((s) => PlanStepKind.DRIVE === s.kind).map((s) => s.why);
  const flows = await readFlows(reads);
  const known = await productRules(deps, options.sessionId);
  // The platform plans: personas, order, branches and the product rules each journey proves.
  // A platform that cannot plan leaves the caller to drive the journey through it unplanned.
  const platform = serverOptionsFromEnv(env);
  if (platform === undefined) return undefined;
  // What the screen offers, for a named journey too. The platform splits a broad request ("test my
  // app, make a plan") into journeys through these controls and leaves a narrow one whole; without
  // them, a chat-requested drive of a desktop app planned one step that restated the request.
  const about = await aboutTheApp(
    planAsText(plan),
    (name, args) => reticleToolset(deps, pinned(options)).invoke(name, args),
    await controlsSeenBefore(deps, options.sessionId),
  );
  const personas = focus === undefined ? personasIn(flows) : [];
  const proposed = await proposeScript(platform, {
    about,
    flows,
    replay,
    goals,
    gaps,
    rules: known,
    personas,
  });
  if (proposed === undefined || 0 < checkScript(proposed.script).length) return undefined;
  const { script, planId } = proposed;
  // Saved the moment it exists, so a drive that breaks still leaves its plan behind.
  const planFile = await savePlan(deps, options.sessionId, { planId, script });

  const maxSteps = options.maxSteps ?? maxStepsFromEnv(env);
  // The script replays the saved flows itself; a model handed them too replayed them again per goal.
  const open = withoutReplays(plan);
  // The journey itself leads (its rules are already written into it by the platform): a driver
  // with nothing named to prove stopped after its first half.
  const planFor = (goal?: string): HarnessPlan => {
    if (goal === undefined) return open;
    const journey = { kind: PlanStepKind.DRIVE, target: 'this journey, to its end', why: goal };
    return { ...open, steps: [journey, ...open.steps] };
  };
  const driverFor = (persona?: string, goal?: string): { driver: ModelDriver; name: string } =>
    options.driver === undefined
      ? buildDriver(
          env,
          maxSteps,
          planFor(goal),
          options.driverName,
          persona,
          persona === undefined ? goal : undefined,
        )
      : { driver: options.driver, name: CUSTOM_DRIVER_NAME };
  const driverName = driverFor().name;
  const harness = randomUUID();
  const narrate = narrator(deps, options);

  // Lanes run side by side only in leased contexts; without a pool they take turns on this tab.
  const pool = deps.pool;
  const appUrl = leasableAppUrl(deps, options.sessionId);
  const leasing = pool !== undefined && appUrl !== undefined && 1 < script.lanes.length;
  const projectId = safeProjectId(deps, options.sessionId);
  let off = false;
  const poll = setInterval(() => {
    void refusedByPlatform(env, options).then((refusal) => {
      if (MSG_HARNESS_DISABLED === refusal) off = true;
    });
  }, STOP_POLL_MS);
  poll.unref();

  const lanes = laneIds(harness, leasing);
  // Keyed by the tool list, which the script runner's recording wrapper passes through unchanged.
  const harnessOf = new WeakMap<object, string>();

  const ports: ScriptPorts = {
    parallel: leasing ? Math.max(1, Math.min(script.lanes.length, pool.capacity(), MAX_LANES)) : 1,
    stopped: () => off,
    lease: async () => {
      if (!leasing) return { ...pinned(options), release: () => Promise.resolve() };
      const acquire = () => acquireLeasedSession(pool, deps.sessions, appUrl, projectId);
      // A cold dev server can miss the first load while other lanes compile it; the second finds it warm.
      return acquire().catch(acquire);
    },
    toolset: (sessionId, persona) => {
      const id = lanes.idFor(sessionId);
      const toolset = reticleToolset(deps, {
        ...(sessionId === undefined ? {} : { sessionId }),
        drivenBy: {
          harness: id,
          driver: driverName,
          ...(persona === undefined ? {} : { persona }),
        },
      });
      harnessOf.set(toolset.tools, id);
      return toolset;
    },
    drive: async (toolset, goal, steps) => {
      const persona =
        focus ??
        (script.personas.find((p) => goal.startsWith(`${p.name}:`)) === undefined
          ? undefined
          : goal);
      const ahead = new Set(await reads.flows.list());
      const result = await runHarness(driverFor(persona, goal).driver, toolset, {
        maxSteps: Math.min(steps, maxSteps),
        focus: [planAsText(planFor(goal)), `Focus: ${goal}`].join('\n\n'),
      });
      // Before the lane's session ends and is graded, so its run cannot read "Proved" over a goal
      // the drive did not reach.
      noteHarnessGoal(harnessOf.get(toolset.tools) ?? harness, result.goalMet);
      await bankOpenRecording(toolset, result, persona);
      if (persona !== undefined) {
        const saved = reconcileFlows(ahead, await reads.flows.list(), result.toolCalls);
        await recordPersona(reads, [...saved.savedFlows, ...saved.rewroteFlows], persona);
      }
      return result;
    },
  };

  narrate(
    `Harness plan from the platform · ${String(script.journeys.length)} journeys in ${String(script.lanes.length)} lane(s)` +
      (1 < ports.parallel ? `, ${String(ports.parallel)} at once` : ''),
  );
  let run: ScriptRun;
  try {
    run = await runScript(script, ports, (view) => {
      try {
        deps.sessions.resolve(options.sessionId).pushView(ReticleCommand.PLAN, view);
      } catch {
        /* nobody is watching: the plan still runs */
      }
    });
  } finally {
    clearInterval(poll);
  }
  // The whole app, after the journeys: a crawl clicks every reachable control (nothing destructive)
  // and finds what no journey is aimed at — a nav link that renders nothing, a dead control, an
  // error in the console. On the merchant dashboard eight blank pages went unreported without it.
  // After the journeys, so the lanes start sooner. (Run first, it once left every lane unable to
  // start; that did not reproduce on a clean install, and was the checkout's, not the order's.)
  const crawled =
    focus === undefined && !run.stopped
      ? await crawlApp(deps, options, harness, driverName)
      : undefined;
  // How each journey went: kept beside the plan here, and told to the platform, whose next plan
  // drives what failed first.
  const results = journeyResults(run.view);
  await savePlan(
    deps,
    options.sessionId,
    { planId, script, results, ...appControlsOf(run.toolCalls, crawled) },
    planFile,
  );
  if (planId !== undefined) await reportPlanResults(platform, planId, results);
  for (const line of run.lines) narrate(line);
  narrate(
    run.stopped
      ? 'Autonomous driving switched off — the Harness stopped. What it drove is kept.'
      : `Harness finished the plan — ${String(run.lines.filter((l) => l.startsWith('✓')).length)} of ${String(run.lines.length)} journeys passed. ${verdictLine(checkTally(run.toolCalls))}`,
  );

  const sum = (pick: (r: HarnessResult) => number): number =>
    run.drives.reduce((n, r) => n + pick(r), 0);
  // A model drive that broke breaks the run: "finished" over a platform that answered 500 hid it.
  const broke = run.drives.find((d) => StopReason.BROKEN === d.stopReason);
  const drive: HarnessResult = {
    stopReason: run.stopped
      ? StopReason.STOPPED
      : broke !== undefined
        ? StopReason.BROKEN
        : StopReason.FINISHED,
    ...(broke?.error === undefined ? {} : { error: broke.error }),
    summary: run.drives
      .map((d) => d.summary)
      .filter((t) => 0 < t.length)
      .join('\n'),
    steps: run.toolCalls.length,
    toolCalls: crawled === undefined ? run.toolCalls : [crawled, ...run.toolCalls],
    usage: {
      input: sum((r) => r.usage.input),
      output: sum((r) => r.usage.output),
      cacheRead: sum((r) => r.usage.cacheRead),
      cacheWrite: sum((r) => r.usage.cacheWrite),
    },
    proved: run.view.lanes.some((lane) =>
      lane.journeys.some((card) => ScriptStatus.PASSED === card.status),
    ),
    // Unmet if any journey's goal was judged unmet; met only when every judged one was.
    ...goalOfRun(run.drives),
  };
  const reconciled = reconcileFlows(before, await reads.flows.list(), run.toolCalls);
  const runIds = lanes.all().flatMap((id) => {
    const runId = harnessRunId(id);
    return runId === undefined ? [] : [runId];
  });
  const unverifiedFlows = await flowsThatCheckNothing(reads, [
    ...reconciled.savedFlows,
    ...reconciled.rewroteFlows,
  ]);
  return {
    drive,
    plan,
    driverName,
    ...reconciled,
    unverifiedFlows,
    // The texts a named journey quoted must be on the page at the end, checked as the persona
    // drive always checked them.
    goals: await checkGoals(
      (name, args) => ports.toolset(pinned(options).sessionId, focus).invoke(name, args),
      options.goals ?? goalsIn(focus),
    ),
    ...(0 === runIds.length ? {} : { runIds }),
    planLines: [
      `Plan · ${String(script.journeys.length)} journeys in ${String(script.lanes.length)} lane(s)`,
      ...run.lines,
    ],
  };
}

/** What the project still owes, in its own words: the user's recent request, then open intents. */
async function memoryGoals(deps: ToolDeps, sessionId?: string): Promise<string[]> {
  const goals: string[] = [];
  try {
    const parsed = PromptContextSchema.safeParse(
      JSON.parse(await deps.fs.readFile(reticleDirPaths(sessionRoot(deps, sessionId)).request)),
    );
    const at = parsed.success ? parsed.data.at : undefined;
    const request = parsed.success ? parsed.data.request : undefined;
    if (request !== undefined && at !== undefined && deps.now() - at < REQUEST_FRESH_MS) {
      goals.push(request);
    }
  } catch {
    /* no request declared: the common case */
  }
  try {
    for (const intent of await openSessionIntents(deps, sessionId)) goals.push(intent.statement);
  } catch {
    /* no intent ledger */
  }
  return [...new Set(goals.map((g) => g.trim().slice(0, MAX_GOAL_CHARS)))].filter(
    (g) => 0 < g.length,
  );
}

function safeProjectId(deps: ToolDeps, sessionId?: string): string | undefined {
  try {
    return sessionTarget(deps, sessionId).projectId;
  } catch {
    return undefined;
  }
}

/**
 * Keep a plan in `.reticle/plans/`, and how it went once it has run. The same file is rewritten
 * with the results, so one plan is one file. Never fails the drive: a plan that cannot be written
 * is still a plan that runs.
 */
async function savePlan(
  deps: ToolDeps,
  sessionId: string | undefined,
  plan: {
    planId?: string | undefined;
    script: DriveScript;
    results?: JourneyResult[];
    appControls?: string[];
  },
  file?: string,
): Promise<string | undefined> {
  try {
    const dir = reticleDirPaths(sessionRoot(deps, sessionId)).plans;
    const path =
      file ?? join(dir, `${new Date(deps.now()).toISOString().replace(/[:.]/g, '-')}.json`);
    await deps.fs.mkdir(dir);
    await deps.fs.writeFile(path, `${JSON.stringify({ at: deps.now(), ...plan }, null, 2)}\n`);
    return path;
  } catch {
    return file;
  }
}

/** The run's goal verdict: false if any drive missed its goal, true if all judged ones reached it. */
function goalOfRun(drives: readonly HarnessResult[]): { goalMet?: boolean } {
  const judged = drives.flatMap((d) => (d.goalMet === undefined ? [] : [d.goalMet]));
  return 0 === judged.length ? {} : { goalMet: judged.every(Boolean) };
}

/** Controls the opening crawl clicks: enough for a dashboard's navigation and its main buttons. */
const CRAWL_STEPS = 30;
const CRAWL_ACTION = 'crawl';

/** The opening crawl, as one recorded call. Undefined when it could not run; the plan runs anyway. */
async function crawlApp(
  deps: ToolDeps,
  options: ExploreOptions,
  harness: string,
  driver: string,
): Promise<ToolOutcome | undefined> {
  // The crawl is an action of `reticle_verify` now; by its old name it answered "unknown tool",
  // which read as a crawl that found nothing.
  const args = { action: CRAWL_ACTION, maxSteps: CRAWL_STEPS };
  try {
    const result = await reticleToolset(deps, {
      ...pinned(options),
      drivenBy: { harness, driver },
    }).invoke(ReticleTool.VERIFY, args);
    if (undefined !== asRecord(result)['error']) return undefined;
    return { id: 'crawl', name: ReticleTool.CRAWL, args, result, isError: false };
  } catch {
    return undefined;
  }
}

/**
 * The controls the last crawl saw, from the newest saved plan that kept them. The planner reads the
 * start page only; without these it never learned the refund buttons on another page existed, and
 * no journey went near the app's costliest defects.
 */
async function controlsSeenBefore(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<string[]> {
  try {
    const dir = reticleDirPaths(sessionRoot(deps, sessionId)).plans;
    const files = (await deps.fs.readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    for (const file of files) {
      const saved = asRecord(JSON.parse(await deps.fs.readFile(join(dir, file))));
      const controls = saved['appControls'];
      if (Array.isArray(controls))
        return controls.filter((c): c is string => 'string' === typeof c);
    }
  } catch {
    /* no plans yet: the planner works from the screen alone */
  }
  return [];
}
