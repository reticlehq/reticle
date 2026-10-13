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
import {
  ReticleCommand,
  ReticleTool,
  ScriptStatus,
  asRecord,
  type SeedStorage,
} from '@reticlehq/core';
import {
  JourneyBy,
  PromptContextSchema,
  checkScript,
  type DriveScript,
} from '@reticlehq/core/artifacts';
import {
  runScript,
  type JourneyRun,
  type ScriptPorts,
  type ScriptRun,
} from '@/features/harness/script/script-run.js';
import { CUSTOM_DRIVER_NAME } from '@/features/harness/drivers.js';
import {
  actedOnApp,
  checkTally,
  pagesReached,
  typedValues,
  verdictLine,
  type JourneyStatus,
} from '@/features/harness/drive-report.js';
import {
  runHarness,
  StopReason,
  type HarnessResult,
  type ModelDriver,
  type ToolOutcome,
} from '@/features/harness/harness.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import {
  harnessRunId,
  noteHarnessDisparity,
  noteHarnessGoal,
  noteHarnessSpan,
} from '@/judgement/runs/drive-run.js';
import { openSessionIntents } from '@/memory/intent/open-intents.js';
import { sessionRoot, sessionTarget } from '@/memory/project/session-root.js';
import { leasableAppUrl, sessionUrlOf } from '@/language/flows/flow-tools.js';
import type { ToolDeps } from './tool-kit.js';
import { acquireLeasedSession, suiteFixtureSeed } from './lease-tools.js';
import { reticleToolset } from './harness-toolset.js';
import { laneIds } from '@/features/harness/script/lane-ids.js';
import { appControlsOf } from '@/features/harness/script/app-controls.js';
import { surveyedSince } from '@/features/harness/explore/site-map.js';
import {
  PlanStepKind,
  aboutTheApp,
  drivingPlan,
  planAsText,
  type HarnessPlan,
} from './harness-plan.js';
import {
  fetchScript,
  journeyResults,
  personasIn,
  proposeScript,
  reportPlanBlocked,
  reportPlanResults,
  type JourneyResult,
} from '@/features/harness/platform/script.js';
import { goalOfDrive, parseGoals, readOpening } from '@/features/harness/goals.js';
import {
  bestOfLanes,
  huntAndGrade,
  knownRoutes,
  refreshMap,
  siteMapFor,
  type Graded,
} from './harness-hunt.js';
import {
  serverOptionsFromEnv,
  type PlatformCredential,
} from '@/features/harness/platform/server-driver.js';
import {
  MSG_HARNESS_DISABLED,
  bankOpenRecording,
  buildDriver,
  firstLine,
  flowsThatCheckNothing,
  maxStepsFromEnv,
  msgDriveCutOff,
  narrator,
  pinned,
  productRules,
  readFlows,
  readPlan,
  reconcileFlows,
  recordPersona,
  refusedByPlatform,
  steering,
  withProjectFlows,
  type ExploreOptions,
  type ExploreResult,
} from './harness-explore.js';

/** A saved plan this run was asked for and could not read: said, never swapped for another drive. */
export const msgSavedPlanUnreadable = (planId: string): string =>
  `The saved plan ${planId} could not be read from the Reticle platform, or it no longer runs as written. Open it on the dashboard, fix it, and run it again.`;

/** The platform could not plan the run: the drive that follows is the journey alone, unplanned. */
export const msgNoPlan = (why: string): string =>
  `No plan this time — ${why.replace(/\.$/, '')}. Driving the journey on its own instead.`;

/** Said when a plan's lanes cannot carry this tab's sign-in into new browsers, so they take turns here. */
export const MSG_LANES_IN_THIS_TAB =
  "The plan's lanes take turns in this tab: a new browser would start signed out, and this tab's " +
  'sign-in could not be copied into one.';

/**
 * The sign-in a plan's lanes start from: what this tab's browser holds, or undefined when it cannot
 * be copied (no browser this daemon drives, nothing to copy), in which case the lanes take turns here.
 */
export async function laneSeed(
  deps: ToolDeps,
  sessionId: string | undefined,
  appUrl: string | undefined,
): Promise<SeedStorage | undefined> {
  if (appUrl === undefined) return undefined;
  return suiteFixtureSeed(deps.realInput, sessionUrlOf(deps, sessionId) ?? appUrl);
}

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
  const gaps = drivingPlan(plan, focus).steps.map((s) => s.why);
  const flows = await readFlows(reads);
  const known = await productRules(deps, options.sessionId);
  // The platform plans: personas, order, branches and the product rules each journey proves.
  // A platform that cannot plan leaves the caller to drive the journey through it unplanned.
  const platform = serverOptionsFromEnv(env);
  // A saved plan is the platform's: without it there is nothing to run, and driving something else
  // in its place would answer a question nobody asked.
  if (platform === undefined && options.planId !== undefined)
    throw new Error(msgSavedPlanUnreadable(options.planId));
  if (platform === undefined) return undefined;
  if (options.planId !== undefined) {
    const planId = options.planId;
    // Refused or broken before a journey ran is still said to the plan, so its history shows it.
    // ponytail: a throw from inside a running plan is reported as all blocked too; runPlan reports
    // real results itself whenever it returns.
    try {
      const saved = await fetchScript(platform, planId);
      if (saved === undefined) throw new Error(msgSavedPlanUnreadable(planId));
      return await runPlan(deps, env, options, before, { platform, plan, script: saved, planId });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      await reportPlanBlocked(platform, planId, firstLine(why));
      throw error;
    }
  }
  // The same persona runs the plan it made last time, as it stands on the platform now (edits and
  // replay-first included): a new plan per HUD run meant a passed journey was never replayed.
  const again = focus === undefined ? undefined : await planMadeFor(deps, options.sessionId, focus);
  const reused = again === undefined ? undefined : await fetchScript(platform, again);
  if (again !== undefined && reused !== undefined)
    return runPlan(deps, env, options, before, { platform, plan, script: reused, planId: again });
  // What the screen offers, for a named journey too. The platform splits a broad request ("test my
  // app, make a plan") into journeys through these controls and leaves a narrow one whole; without
  // them, a chat-requested drive of a desktop app planned one step that restated the request.
  const about = await aboutTheApp(
    planAsText(focus === undefined ? plan : drivingPlan(plan, focus)),
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
  if (proposed !== undefined && 'refused' in proposed) {
    // Said where the run is watched: the drive goes on without a plan, and that is not what was asked.
    narrator(deps, options)(msgNoPlan(proposed.refused), true);
    return undefined;
  }
  if (proposed === undefined || 0 < checkScript(proposed.script).length) return undefined;
  return runPlan(deps, env, options, before, {
    platform,
    plan,
    script: proposed.script,
    ...(proposed.planId === undefined ? {} : { planId: proposed.planId }),
    ...(proposed.creditsSpent === undefined ? {} : { planCredits: proposed.creditsSpent }),
  });
}

/** Run a plan the platform wrote (just now, or saved and maybe edited since), and report how it went. */
async function runPlan(
  deps: ToolDeps,
  env: Record<string, string | undefined>,
  options: ExploreOptions,
  before: ReadonlySet<string>,
  planned: {
    platform: PlatformCredential;
    plan: HarnessPlan;
    script: DriveScript;
    planId?: string;
    /** What writing the plan cost, added to what the lanes spent. */
    planCredits?: number;
  },
): Promise<ExploreResult> {
  const { platform, plan, script, planId } = planned;
  const reads = withProjectFlows(deps, options.sessionId);
  const focus = options.focus;
  // Saved the moment it exists, so a drive that breaks still leaves its plan behind.
  const planFile = await savePlan(deps, options.sessionId, {
    planId,
    script,
    ...(focus === undefined ? {} : { focus }),
  });

  const maxSteps = options.maxSteps ?? maxStepsFromEnv(env);
  // The script replays the saved flows itself; a model handed them too replayed them again per goal.
  const open = drivingPlan(plan, focus);
  // The journey itself leads (its rules are already written into it by the platform): a driver
  // with nothing named to prove stopped after its first half.
  const planFor = (goal?: string): HarnessPlan => {
    if (goal === undefined) return open;
    const journey = { kind: PlanStepKind.DRIVE, target: 'this journey, to its end', why: goal };
    return { ...open, steps: [journey, ...open.steps] };
  };
  // Map first: survey the app (no model) unless its map is fresh; every lane's engine looks goals up
  // in it, and the hunt before grading starts from it. The tab is left where it started.
  const mapAsked = deps.now();
  const map = await siteMapFor(deps, options.sessionId, (name, args) =>
    reticleToolset(deps, pinned(options)).invoke(name, args),
  );
  const driverFor = (persona?: string, goal?: string): { driver: ModelDriver; name: string } =>
    options.driver === undefined
      ? buildDriver(
          env,
          maxSteps,
          planFor(goal),
          options.driverName,
          persona,
          persona === undefined ? goal : undefined,
          map,
        )
      : { driver: options.driver, name: CUSTOM_DRIVER_NAME };
  const driverName = driverFor().name;
  const harness = options.harnessId ?? randomUUID();
  const narrate = narrator(deps, options);

  // Lanes run side by side only in leased contexts; without a pool they take turns on this tab.
  const pool = deps.pool;
  const appUrl = leasableAppUrl(deps, options.sessionId);
  const wantsLanes = pool !== undefined && appUrl !== undefined && 1 < script.lanes.length;
  // A new context starts signed out: lanes once spent a whole run (three lanes, twelve credits) on
  // /login, a page that was not the journey. They start from what this tab holds, or take turns here.
  const seed = wantsLanes ? await laneSeed(deps, options.sessionId, appUrl) : undefined;
  const leasing = wantsLanes && seed !== undefined;
  if (wantsLanes && !leasing) narrator(deps, options)(MSG_LANES_IN_THIS_TAB);
  const projectId = safeProjectId(deps, options.sessionId);
  let off = false;
  const poll = setInterval(() => {
    void refusedByPlatform(env, options).then((refusal) => {
      if (MSG_HARNESS_DISABLED === refusal) off = true;
    });
  }, STOP_POLL_MS);
  poll.unref();

  const lanes = laneIds(harness, leasing);
  const endGoalsAsked = options.goals ?? parseGoals(focus);
  const laneGrades: Graded[] = [];
  // Keyed by the tool list, which the script runner's recording wrapper passes through unchanged.
  const harnessOf = new WeakMap<object, string>();

  const own = [...(focus === undefined ? [] : [focus]), ...scriptTexts(script)];
  const ports: ScriptPorts = {
    own,
    parallel: leasing ? Math.max(1, Math.min(script.lanes.length, pool.capacity(), MAX_LANES)) : 1,
    stopped: () => off || true === options.stopped?.(),
    // A replay-only plan started without the model's gates; a fallback is the model, so it asks now.
    fallbackRefused: async () => {
      const refusal = await refusedByPlatform(env, options);
      return refusal === undefined ? undefined : firstLine(refusal);
    },
    ...(true === options.confirmDangerous ? { confirmDangerous: true } : {}),
    lease: async () => {
      if (!leasing) return { ...pinned(options), release: () => Promise.resolve() };
      const acquire = () => acquireLeasedSession(pool, deps.sessions, appUrl, projectId, seed);
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
        // The person's request, never the planned journey's text: a planner-invented journey
        // ("press Invite") must not be what allows an invite.
        ...(focus === undefined ? {} : { asked: focus }),
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
      const driven = await runHarness(driverFor(persona, goal).driver, toolset, {
        ...steering(options),
        maxSteps: Math.min(steps, maxSteps),
        routes: knownRoutes(map),
        focus: [planAsText(planFor(goal)), `Focus: ${goal}`].join('\n\n'),
      });
      // The driver's word, unless the lane did nothing: then its goal was not met by it.
      const laneGoal = goalOfDrive(driven.goalMet, [], actedOnApp(driven.toolCalls));
      const result = { ...driven, ...(laneGoal === undefined ? {} : { goalMet: laneGoal }) };
      // Before the lane's session ends and is graded, so its run cannot read "Proved" over a goal
      // the drive did not reach.
      noteHarnessGoal(harnessOf.get(toolset.tools) ?? harness, result.goalMet);
      const banked = await bankOpenRecording(toolset, result, persona, goal);
      // A lane in its own browser is graded where it drove: the caller's tab never saw its pages.
      if (leasing && 0 < endGoalsAsked.length)
        laneGrades.push(
          await huntAndGrade(deps, (name, args) => toolset.invoke(name, args), {
            sessionId: options.sessionId,
            goals: endGoalsAsked,
            expect: options.expect,
            opening,
            journey: goal,
            map,
            own,
            reached: pagesReached(result.toolCalls),
            typed: typedValues(result.toolCalls),
          }),
        );
      if (persona !== undefined) {
        const saved = reconcileFlows(ahead, await reads.flows.list(), [
          ...result.toolCalls,
          ...banked,
        ]);
        await recordPersona(reads, [...saved.savedFlows, ...saved.rewroteFlows], persona);
      }
      return result;
    },
  };

  narrate(
    `Harness plan from the platform · ${String(script.journeys.length)} journeys in ${String(script.lanes.length)} lane(s)` +
      (1 < ports.parallel ? `, ${String(ports.parallel)} at once` : ''),
  );
  // Read before anything is driven: a goal this page already shows proves nothing at the end.
  const endInvoke = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    ports.toolset(pinned(options).sessionId, focus).invoke(name, args);
  const opening = await readOpening(endInvoke);
  const runStarted = deps.now();
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
  // Once per map: a run on a fresh map swept the whole app again, every time.
  const crawled =
    focus === undefined && !run.stopped && surveyedSince(map, mapAsked)
      ? await crawlApp(deps, options, harness, driverName)
      : undefined;
  // How each journey went: kept beside the plan here, and told to the platform, whose next plan
  // drives what failed first.
  const results = journeyResults(run.view, run.journeys);
  await savePlan(
    deps,
    options.sessionId,
    {
      planId,
      script,
      ...(focus === undefined ? {} : { focus }),
      results,
      ...appControlsOf(run.toolCalls, crawled),
    },
    planFile,
  );
  for (const line of run.lines) narrate(line);
  const cutOff = run.drives.find((d) => StopReason.BROKEN === d.stopReason);
  narrate(
    run.stopped
      ? 'Autonomous driving switched off — the Harness stopped. What it drove is kept.'
      : cutOff !== undefined
        ? msgDriveCutOff(cutOff.error)
        : // One verdict, the journeys': the count of passed journeys is in it, said once.
          `Harness finished the plan${answeredBy(run.journeys)}. ${verdictLine(checkTally(run.toolCalls), undefined, results)}`,
  );

  const sum = (pick: (r: HarnessResult) => number): number =>
    run.drives.reduce((n, r) => n + pick(r), 0);
  // A model drive that broke breaks the run: "finished" over a platform that answered 500 hid it.
  const broke = cutOff;
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
    ...goalOfRun(run.drives, results),
    // What every lane cost, as the platform said; a planned run dropped it and read as free.
    ...(run.drives.some((d) => d.creditsSpent !== undefined) || planned.planCredits !== undefined
      ? { creditsSpent: sum((r) => r.creditsSpent ?? 0) + (planned.planCredits ?? 0) }
      : {}),
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
  await refreshMap(deps, options.sessionId, map, run.toolCalls);
  // The texts a named journey quoted must be on the page at the end, hunted for first (a goal the
  // drive walked past or stopped short of is looked for, not graded where it stood), and not counted
  // when the page showed them before the drive began.
  // Lanes in their own browsers were graded where they drove, and a goal any lane proved is proved;
  // lanes taking turns here end on this tab, so it is graded here.
  const graded =
    0 < laneGrades.length
      ? bestOfLanes(laneGrades)
      : await huntAndGrade(deps, endInvoke, {
          sessionId: options.sessionId,
          goals: endGoalsAsked,
          expect: options.expect,
          opening,
          journey: focus,
          map,
          own,
          reached: pagesReached(run.toolCalls),
          typed: typedValues(run.toolCalls),
        });
  const goals = graded.goals;
  for (const id of lanes.all()) noteHarnessDisparity(id, graded.disparity);
  const goalMet = goalOfDrive(drive.goalMet, goals, actedOnApp(run.toolCalls));
  if (0 < goals.length) for (const id of lanes.all()) noteHarnessGoal(id, goalMet);
  // After the goals are graded: a journey that "passed" over goals that came back unmet is not.
  // ponytail: one run-wide goalMet on every journey; per-journey once lanes grade their own goals.
  if (planId !== undefined)
    await reportPlanResults(
      platform,
      planId,
      goalMet === undefined ? results : results.map((r) => ({ ...r, goalMet })),
      runIds,
    );
  // ponytail: every lane is given the run's time; per-lane timing if lanes ever report their own.
  for (const id of lanes.all()) noteHarnessSpan(id, deps.now() - runStarted);
  return {
    // The hunt's navigations too, after the goal was decided on what the plan itself drove.
    drive: {
      ...drive,
      toolCalls: [...drive.toolCalls, ...graded.moved],
      ...(goalMet === undefined ? {} : { goalMet }),
    },
    plan,
    driverName,
    ...reconciled,
    unverifiedFlows,
    goals,
    ...(0 === graded.disparity.length ? {} : { disparity: graded.disparity }),
    ...(0 === runIds.length ? {} : { runIds }),
    ...(planId === undefined ? {} : { planId }),
    journeys: results,
    planLines: [
      `Plan · ${String(script.journeys.length)} journeys in ${String(script.lanes.length)} lane(s)`,
      ...run.lines,
    ],
  };
}

/**
 * How the journeys were answered: replayed with no model, or driven by it and what that cost. Only
 * what was measured; what a replay saved is not, since its journey was not also driven to compare.
 */
function answeredBy(journeys: readonly JourneyRun[]): string {
  if (0 === journeys.length) return '';
  const driven = journeys.filter((j) => JourneyBy.MODEL === j.by);
  const replayed = journeys.filter((j) => JourneyBy.REPLAY === j.by).length;
  const tokens = driven.reduce((n, j) => n + j.tokens, 0);
  return ` (${String(replayed)} replayed with no model, ${String(driven.length)} driven by the model${0 === driven.length ? '' : `, ${String(tokens)} tokens`})`;
}

/**
 * Every text the plan writes down that a page could show back: journey titles, open goals, personas.
 * The platform names the saved plan after them, so they are the Harness's words, never evidence.
 */
function scriptTexts(script: DriveScript): string[] {
  return [
    ...script.journeys.flatMap((j) => [
      j.title,
      ...j.steps.flatMap((s) => ('goal' in s && s.goal !== undefined ? [s.goal] : [])),
    ]),
    ...script.personas.map((p) => p.journey),
  ];
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
    /** The persona the run was asked for, so the next run as that persona runs this plan again. */
    focus?: string;
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

/**
 * The run's goal verdict: false if any drive missed its goal, true if all judged ones reached it.
 * Every journey passed is the page's answer, already graded at each journey's end: a driver's own
 * "not done" (a lane whose model call failed) read "but the goal was not reached" beside it.
 */
export function goalOfRun(
  drives: readonly HarnessResult[],
  journeys: readonly JourneyStatus[],
): { goalMet?: boolean } {
  if (0 < journeys.length && journeys.every((j) => ScriptStatus.PASSED === j.status)) return {};
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

/** The platform plan the newest saved run as `focus` ran, or undefined when none did. */
async function planMadeFor(
  deps: ToolDeps,
  sessionId: string | undefined,
  focus: string,
): Promise<string | undefined> {
  try {
    const dir = reticleDirPaths(sessionRoot(deps, sessionId)).plans;
    const files = (await deps.fs.readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    for (const file of files) {
      const saved = asRecord(JSON.parse(await deps.fs.readFile(join(dir, file))));
      const planId = saved['planId'];
      if (focus === saved['focus'] && 'string' === typeof planId) return planId;
    }
  } catch {
    /* no plans yet: this persona is planned afresh */
  }
  return undefined;
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
