/**
 * One autonomous drive of a connected app, and what it left behind.
 *
 * This is the glue between the loop, the model and Reticle's own tools — and the place where the
 * economics of the feature are decided. A drive costs a model; a SAVED FLOW costs nothing to run
 * again. So the thing this returns that matters is not the model's account of what it did (which
 * nothing grades) but the flows that now exist on disk, because every future run replays those
 * deterministically with no model in the loop at all.
 */

import { serverDriver, serverOptionsFromEnv } from '@/features/harness/platform/server-driver.js';
import { exploreScript } from './harness-script.js';
import { randomUUID } from 'node:crypto';
import {
  harnessRunId,
  noteHarnessDisparity,
  noteHarnessGoal,
  noteHarnessSpan,
} from '@/judgement/runs/drive-run.js';
import { ReticleEnv, ReticleTool, asProjectId, asRecord, type FlowFile } from '@reticlehq/core';
import { flowsForSession } from '@/language/flows/flow-store-for-session.js';
import { projectForRoot } from '@/memory/project/project-for-root.js';
import type { ToolDeps } from './tool-kit.js';
import {
  actedOnApp,
  checkTally,
  pagesReached,
  typedValues,
  verdictLine,
} from '@/features/harness/drive-report.js';
import { CUSTOM_DRIVER_NAME, SERVER_DRIVER } from '@/features/harness/drivers.js';
import { buildDomainModel } from '@/judgement/domain/domain-model.js';
import { readContract } from '@/memory/project/dir/reticle-dir.js';
import { sessionRoot, sessionTarget } from '@/memory/project/session-root.js';
import {
  dashboardPlanUrl,
  dashboardRunUrl,
  readDashboardUrl,
  readLinkedProjectId,
} from '@/memory/project/sync-status.js';
import { buildHarnessPlan, drivingPlan, planAsText, type HarnessPlan } from './harness-plan.js';
import { allSessionIntents } from '@/memory/intent/open-intents.js';
import type { ConfigFetch } from '@/features/harness/platform-config.js';
import type { JourneyResult } from '@/features/harness/platform/script.js';
import {
  DEFAULT_MAX_STEPS,
  runHarness,
  StopReason,
  type HarnessOptions,
  type HarnessResult,
  type HarnessToolset,
  type ModelDriver,
  type ToolOutcome,
} from '@/features/harness/harness.js';
import { reticleToolset } from './harness-toolset.js';
import { DriveRefusedError, noteDriveLine } from '@/features/harness/drive-runs.js';
import { personaCredentials } from '@/features/harness/platform/persona-credentials.js';
import {
  endOf,
  goalOfDrive,
  parseGoals,
  readOpening,
  unprovedGoals,
  type GoalCheck,
} from '@/features/harness/goals.js';
import type { RunDisparity } from '@reticlehq/core';
import type { HarnessMap } from '@reticlehq/core/artifacts';
import { mapForPlatform } from '@/features/harness/explore/site-map.js';
import { huntAndGrade, knownRoutes, refreshMap, siteMapFor } from './harness-hunt.js';
export {
  MSG_HARNESS_DISABLED,
  MSG_HARNESS_UNCLAIMED,
  MSG_HARNESS_UNCONFIRMED,
} from '@/features/harness/platform/refusal.js';
import { HarnessNotLinkedError, MSG_NO_HARNESS_KEY, refusedForPlan } from './harness-gate.js';
// The gate a drive passes before it starts moved to its own module; its names are still asked for here.
export {
  HarnessNotLinkedError,
  MSG_NO_HARNESS_KEY,
  firstLine,
  harnessAvailable,
  harnessStartRefusal,
  refusedByPlatform,
  withLinkedCredential,
} from './harness-gate.js';

export interface ExploreOptions {
  /** Who to be, or what to accomplish. Appended to the standing instruction. */
  focus?: string;
  /**
   * A person started this run (Run plan from the dashboard) and acknowledged the saved flows' own
   * destructive steps: a planned replay may take them. Never a step the model decides.
   */
  confirmDangerous?: boolean;
  /** Texts the drive must leave on the page. Default: whatever `focus` quoted. See goals.ts. */
  goals?: readonly string[];
  /** The outcome the journey must end in, as a reticle_assert predicate. See `checkExpect`. */
  expect?: Record<string, unknown>;
  /** Pinned tab, when the app has more than one connected. */
  sessionId?: string;
  /** Hard ceiling on model turns. Bounds cost, not value — the drive is usable however it ends. */
  maxSteps?: number;
  /**
   * Which driver to use for THIS drive, overriding the environment.
   *
   * Per-call rather than only per-daemon because the question people actually have is comparative —
   * "is the cheap driver good enough for my app?" — and answering it with an environment variable
   * means restarting the daemon between arms, which is exactly the setup that let a stale daemon
   * answer three runs of our own benchmark with one configuration.
   */
  driverName?: string;
  /** Injected for tests, and for anyone driving with a model this repo does not ship a binding for. */
  driver?: ModelDriver;
  /**
   * Skip asking the platform which driver this project prefers.
   *
   * Set by tests and by callers that have already decided. Not a user-facing switch: naming a
   * driver explicitly already skips the lookup, which is the only reason anybody would want to.
   */
  skipPlatformConfig?: boolean;
  /**
   * The GET that asks the platform what this project wants. Injected ONLY by tests.
   *
   * It exists because the two things this answer decides — a driver preference and whether the drive
   * may happen at all — were both unreachable without a network, and the refusal test that was
   * supposed to cover the OFF switch was asserting on a path where the platform is never asked.
   */
  configFetch?: ConfigFetch;
  /** The drive's harness id, minted by the caller so its run id is known before the drive starts. */
  harnessId?: string;
  /** A plan the platform saved (`hp_…`): run it as it stands, instead of asking for a new one. */
  planId?: string;
  /** Asked between turns: whoever started the drive asked it to stop. */
  stopped?: () => boolean;
  /** Asked between turns: what whoever started the drive said to it since. */
  inbox?: () => readonly string[];
}

export interface ExploreResult {
  drive: HarnessResult;
  /** What the drive set out to do, read from `.reticle` before it started. */
  plan: HarnessPlan;
  /** Flows that exist now and did not before — the part of a drive that is worth paying for twice. */
  savedFlows: readonly string[];
  /** Of the saved and rewritten flows, the ones with no step that checks anything. */
  unverifiedFlows: readonly string[];
  /**
   * Flows that already existed and were written again by this drive.
   *
   * Split from `savedFlows` because the before/after name diff cannot see a rewrite, and read on its
   * own it reported a drive that saved a perfectly good ten-step flow as having saved nothing — over
   * which the caller was told "nothing is proved and nothing will replay". That sentence was false,
   * and a false "nothing was verified" is the same class of mistake as a false "everything passed":
   * the product exists to stop a drive lying about its own outcome, including to us.
   *
   * It happens on any SECOND drive, because a drive that covers the same app records the same
   * journeys under the same names — so this is the ordinary case, not the corner one.
   */
  rewroteFlows: readonly string[];
  /** One verdict per goal, checked by the harness after the drive rather than taken on its word. */
  goals: readonly GoalCheck[];
  /** The persona plan and how each persona ended, when the platform proposed the personas. */
  planLines?: readonly string[];
  /**
   * Which driver actually drove.
   *
   * Reported rather than re-derived by the caller. A second copy of "which driver would be chosen"
   * is a copy that can disagree with the one that chose, and the whole point of naming a driver is
   * to attribute a result to it — a comparison that mislabels its own arms is worse than no
   * comparison. `custom` is an injected driver, which is neither of ours to name.
   */
  driverName: string;
  /** The run this drive syncs as (`harness-<id>`), so a caller can find it on the platform. */
  runIds?: readonly string[];
  /** The run's page on the dashboard, when the project is linked. */
  runUrl?: string;
  /** How each journey of a platform plan ended, worst lane first. Absent for an unplanned drive. */
  journeys?: readonly JourneyResult[];
  /** The platform plan this run drove, which the dashboard keeps, edits and runs again. */
  planId?: string;
  /** That plan's page on the dashboard. */
  planUrl?: string;
  /** Each goal the session's coding agent also judged, and how the two verdicts compare. */
  disparity?: readonly RunDisparity[];
}
/** A driver named that this build no longer has: every Harness decision is the platform's now. */
const msgUnknownDriver = (asked: string): string =>
  `The Harness driver \`${asked}\` is not available: the Harness runs on the Reticle platform, ` +
  `which drives with the model set for the project in the dashboard.`;

/**
 * Read the step ceiling out of the environment.
 *
 * Exported because the number is a budget somebody pays, and a budget that can only be changed by
 * editing the source is not a budget. A value that is not a positive number is IGNORED rather than
 * treated as zero: a typo that silently drove nothing would report a clean-looking run over an app
 * nobody touched.
 */
export function maxStepsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[ReticleEnv.HARNESS_MAX_STEPS];
  if (raw === undefined) return DEFAULT_MAX_STEPS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STEPS;
}

/**
 * Drive a connected app with a model, through Reticle's own tools.
 *
 * The flow list is read before and after rather than taken from the model's word for it. A model
 * that says it saved a flow and did not is the same false green as an app that says it saved a
 * record and did not — and this product does not get to make that mistake about its own work.
 */
export async function exploreApp(
  deps: ToolDeps,
  given: Record<string, string | undefined>,
  asked: ExploreOptions = {},
): Promise<ExploreResult> {
  // Every drive starts here. The credentials a persona names fill its sign-in fields on this
  // machine, and only the redacted text travels on: to the platform, into flows and synced runs.
  const named = asked.focus === undefined ? undefined : personaCredentials(asked.focus);
  const env = named === undefined ? given : { ...given, ...named.secrets };
  const options = named === undefined ? asked : { ...asked, focus: named.persona };
  const refusal = await refusedForPlan(env, options);
  if (refusal !== undefined)
    throw MSG_NO_HARNESS_KEY === refusal.text
      ? new HarnessNotLinkedError()
      : new DriveRefusedError(refusal.text, refusal.reason);
  // The flows a drive reads and diffs are the PROJECT's, which is where its saves land.
  const reads = withProjectFlows(deps, options.sessionId);
  // No journey named: plan the drive first. The platform's Harness proposes the people worth being;
  // the saved flows, the user's request and the unproved intents fill in the rest. The plan is drawn
  // on the HUD and updated as each part runs.
  const before = new Set(await reads.flows.list());
  // Without a named journey the drive is always planned; with one, it is planned by the platform
  // when there is one, and driven here as before when there is not.
  if (
    options.focus === undefined ||
    options.planId !== undefined ||
    serverOptionsFromEnv(env) !== undefined
  ) {
    const scripted = await exploreScript(deps, env, options, before);
    // Where the person opens it: the run, and the plan the dashboard keeps and runs again.
    if (scripted !== undefined)
      return {
        ...scripted,
        ...runUrlFor(deps, options.sessionId, scripted.runIds?.[0]),
        ...planUrlFor(deps, options.sessionId, scripted.planId),
      };
  }

  const maxSteps = options.maxSteps ?? maxStepsFromEnv(env);
  // `.reticle` FIRST, before the app and before anything reads a line of source. It already holds
  // every saved flow, the consequence that must hold for each, and the declared intent nobody has
  // tested — which is the whole of what a drive should be deciding against.
  const plan = await readPlan(reads, options.sessionId);
  const driving = drivingPlan(plan, options.focus);
  // Refused before anything touches the app: an unknown driver, or no platform to drive with.
  if (options.driver === undefined)
    buildDriver(env, maxSteps, driving, options.driverName, options.focus);
  // Every action this drive takes carries who took it, so the run it folds into is the Harness's own
  // and not mixed into the run of whichever agent shares the tab.
  const harnessId = options.harnessId ?? randomUUID();
  const driverLabel = options.driver === undefined ? SERVER_DRIVER : CUSTOM_DRIVER_NAME;
  const toolset = reticleToolset(deps, {
    ...pinned(options),
    drivenBy: {
      harness: harnessId,
      driver: driverLabel,
      ...(options.focus === undefined ? {} : { persona: options.focus }),
    },
    ...(options.focus === undefined ? {} : { asked: options.focus }),
  });
  const narrate = narrator(deps, options);
  const invoke = (name: string, args: Record<string, unknown>): Promise<unknown> =>
    toolset.invoke(name, args);
  // Map first: survey the app (no model) unless this app's map is fresh, and leave the tab at start.
  const map = await siteMapFor(deps, options.sessionId, invoke);
  const built =
    options.driver === undefined
      ? buildDriver(env, maxSteps, driving, options.driverName, options.focus, undefined, map)
      : { driver: options.driver, name: CUSTOM_DRIVER_NAME };
  const driver = built.driver;
  // Read before anything is driven: a goal this page already shows proves nothing at the end.
  const opening = await readOpening(invoke);
  narrate(`Harness is driving${options.focus === undefined ? '' : `: ${options.focus}`}`, true);
  const driveStarted = deps.now();
  const drive = await runHarness(driver, toolset, {
    ...steering(options),
    maxSteps,
    routes: knownRoutes(map),
    // The plan rides in as standing instruction, so it is in front of the model on every turn
    // rather than remembered from a first one. `focus` is the caller's own words and goes last:
    // somebody who named a journey meant that journey, whatever the project's backlog says.
    focus: [
      planAsText(driving),
      ...(options.focus === undefined ? [] : [`Focus: ${options.focus}`]),
    ].join('\n\n'),
    // The end the caller's words quote stops the drive once it shows: see HarnessOptions.endsAt.
    ...((end) =>
      end === undefined || options.focus === undefined
        ? {}
        : { endsAt: { text: end, own: [options.focus] } })(endOf(options.focus ?? '')),
  });

  // Before the session ends and is graded: a drive whose goal was missed, or that was cut off part-way,
  // must not sync as "Proved" on the checks that held before it stopped.
  noteHarnessGoal(harnessId, drive.goalMet);
  narrate(
    StopReason.STOPPED === drive.stopReason
      ? `Autonomous driving switched off — the Harness stopped after ${String(drive.steps)} steps. What it drove is kept.`
      : StopReason.BROKEN === drive.stopReason
        ? msgDriveCutOff(drive.error)
        : `Harness finished — ${verdictLine(checkTally(drive.toolCalls))}`,
    true,
  );
  // MANDATORY, and deliberately outside the loop. A drive that runs out of budget mid-journey, or
  // breaks, or whose model simply stops asking for tools, leaves a recording open and everything it
  // drove unsaved — work paid for and thrown away. Saving is not a decision any model gets to make
  // and not something a step budget gets to cut off, so it happens here, after the loop, always.
  const banked = await bankOpenRecording(toolset, drive, options.focus);
  await refreshMap(deps, options.sessionId, map, drive.toolCalls);
  // Hunt for the journey's end before grading: never a `no` from where the drive happened to stop.
  const graded = await huntAndGrade(deps, invoke, {
    sessionId: options.sessionId,
    goals: options.goals ?? parseGoals(options.focus),
    expect: options.expect,
    opening,
    journey: options.focus,
    map,
    reached: pagesReached(drive.toolCalls),
    typed: typedValues(drive.toolCalls),
  });
  const goals = graded.goals;
  noteHarnessDisparity(harnessId, graded.disparity);
  // The goals it was given decide whether the journey was done, not a click that held on the way,
  // and never the driver's word over a drive that did nothing.
  const goalMet = goalOfDrive(drive.goalMet, goals, actedOnApp(drive.toolCalls));
  noteHarnessGoal(harnessId, goalMet);
  noteHarnessSpan(harnessId, deps.now() - driveStarted);
  const unproved = unprovedGoals(goals);
  if (unproved !== undefined) narrate(unproved, true);

  const after = await reads.flows.list();
  const reconciled = reconcileFlows(before, after, [...drive.toolCalls, ...banked]);
  if (options.focus !== undefined) {
    await recordPersona(
      reads,
      [...reconciled.savedFlows, ...reconciled.rewroteFlows],
      options.focus,
    );
  }
  const unverifiedFlows = await flowsThatCheckNothing(reads, [
    ...reconciled.savedFlows,
    ...reconciled.rewroteFlows,
  ]);
  const runId = harnessRunId(harnessId);
  return {
    // The hunt's navigations after the drive's own calls: they are the Harness driving the app too.
    // After the goal is decided, which counts only what the drive itself did.
    drive: {
      ...drive,
      toolCalls: [...drive.toolCalls, ...graded.moved],
      ...(goalMet === undefined ? {} : { goalMet }),
    },
    plan,
    driverName: built.name,
    ...reconciled,
    unverifiedFlows,
    goals,
    ...(0 === graded.disparity.length ? {} : { disparity: graded.disparity }),
    ...(runId === undefined ? {} : { runIds: [runId] }),
    ...runUrlFor(deps, options.sessionId, runId),
  };
}

/** The stop and the words of whoever started the drive, for `runHarness`. */
export function steering(options: ExploreOptions): Pick<HarnessOptions, 'stopped' | 'inbox'> {
  return {
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }),
    ...(options.inbox === undefined ? {} : { inbox: options.inbox }),
  };
}

/** A line in the HUD's Agent Log for the person watching; nobody watching is not an error. */
export function narrator(
  deps: ToolDeps,
  options: ExploreOptions,
): (text: string, summary?: boolean) => void {
  return (text, summary = false) => {
    // The drive's poll answers with its latest line, whether or not a tab is watching.
    if (options.harnessId !== undefined) noteDriveLine(options.harnessId, text);
    try {
      // Filed in the HUD's Harness log; its start and end lines in the Agent Log too.
      deps.sessions
        .resolve(options.sessionId)
        .pushNarration(text, true, { harness: true, summary });
    } catch {
      /* nobody is watching: the drive still runs */
    }
  };
}

/** The plan's page on the dashboard, where it is edited and run again; nothing when unlinked. */
function planUrlFor(
  deps: ToolDeps,
  sessionId: string | undefined,
  planId: string | undefined,
): { planUrl?: string } {
  if (planId === undefined) return {};
  try {
    const root = sessionRoot(deps, sessionId);
    const dashboard = readDashboardUrl(root);
    return dashboard === undefined
      ? {}
      : {
          planUrl: dashboardPlanUrl({
            dashboardUrl: dashboard,
            planId,
            projectId: readLinkedProjectId(root),
          }),
        };
  } catch {
    return {};
  }
}

/** The run's page on the dashboard, when the tab's project is linked; nothing when it is not. */
function runUrlFor(
  deps: ToolDeps,
  sessionId: string | undefined,
  runId: string | undefined,
): { runUrl?: string } {
  if (runId === undefined) return {};
  try {
    const dashboard = readDashboardUrl(sessionRoot(deps, sessionId));
    return dashboard === undefined ? {} : { runUrl: dashboardRunUrl(dashboard, runId) };
  } catch {
    return {}; // no tab, no project: the run is still reported, without a link
  }
}

export async function productRules(deps: ToolDeps, sessionId?: string): Promise<string[]> {
  try {
    return (await allSessionIntents(deps, sessionId)).map((intent) => intent.statement);
  } catch {
    return [];
  }
}

/** `deps` whose flow store is the session's own project, where the drive's saves land. */
export function withProjectFlows(deps: ToolDeps, sessionId?: string): ToolDeps {
  try {
    return { ...deps, flows: flowsForSession(deps, sessionTarget(deps, sessionId)).flows };
  } catch {
    return deps;
  }
}

/**
 * Write the persona onto every flow the drive saved or rewrote without an intent.
 *
 * Whichever driver saved it, and in whatever words: the cheap driver's own teardown saved its flow
 * with no intent at all, so a replay could never say which journey it was meant to prove. A flow
 * that already carries an intent keeps it. Best effort: a flow that cannot be read or rewritten is
 * still a saved flow.
 */
export async function recordPersona(
  deps: ToolDeps,
  names: readonly string[],
  persona: string,
): Promise<void> {
  // Only the journey itself, "Name: journey": the plan appends the product's rules below it, and
  // keeping them made each plan append them again to a goal that already carried them.
  const intent = (persona.split('\n')[0] ?? '').trim();
  if (0 === intent.length) return;
  for (const name of names) {
    try {
      const loaded = await deps.flows.load(name);
      if (!loaded.ok || (loaded.value.intent ?? '').length > 0) continue;
      // Its own project: without it the store files a flat duplicate beside the original.
      const project = loaded.value.projectId;
      await deps.flows.saveFlow(
        { ...loaded.value, intent },
        project === undefined ? undefined : asProjectId(project),
      );
    } catch {
      /* the flow stays as it was saved */
    }
  }
}

/**
 * The saved flows with no step that asserts a consequence.
 *
 * Such a flow replays as "verified nothing": it clicks through the journey and would pass with the
 * feature broken. Named so the drive's report does not count it as evidence. A flow that cannot be
 * read is left out rather than guessed at.
 */
export async function flowsThatCheckNothing(
  deps: ToolDeps,
  names: readonly string[],
): Promise<readonly string[]> {
  const empty: string[] = [];
  for (const name of names) {
    try {
      const loaded = await deps.flows.load(name);
      if (!loaded.ok) continue;
      if (!loaded.value.steps.some((step) => step.expect !== undefined)) empty.push(name);
    } catch {
      /* unreadable is not the same as empty */
    }
  }
  return empty;
}

/**
 * What a drive actually left behind, split into flows that are NEW and flows it wrote over.
 *
 * Pure, and exported, because it is the part that was wrong and the part worth pinning. The
 * integration around it — a real toolset dispatching a real save — is covered by driving a real app;
 * what a test can usefully hold still is the reconciliation itself.
 *
 * A rewrite is only counted when the drive claims the save AND the store lists the name afterwards.
 * The claim on its own is not evidence, which is the rule this function existed to keep: a model
 * that says it saved something it did not must not be believed. Requiring both is what lets a
 * rewrite be seen at all, since a name that was already there cannot show up in a before/after diff.
 */
export function reconcileFlows(
  before: ReadonlySet<string>,
  after: readonly string[],
  toolCalls: readonly {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
    isError: boolean;
  }[],
): { savedFlows: readonly string[]; rewroteFlows: readonly string[] } {
  const present = new Set(after);
  const claimed = toolCalls
    .filter((call) => ReticleTool.FLOW_SAVE === call.name && !call.isError)
    .map((call) => {
      // The flow's filename is `saveAs` when given, and the recording's name otherwise. Read from
      // the result first, which is what the store actually wrote, and fall back to the request.
      const result = asRecord(call.result)['name'];
      if ('string' === typeof result) return result;
      const args = asRecord(call.args);
      const saveAs = args['saveAs'];
      const flowName = args['flowName'];
      if ('string' === typeof saveAs) return saveAs;
      return 'string' === typeof flowName ? flowName : undefined;
    })
    .filter((name): name is string => name !== undefined && present.has(name));

  // Only what this drive's own saves wrote: a before/after diff of the project's flows claimed the
  // flows other agents saved in the same project at the same time.
  return {
    savedFlows: [...new Set(claimed.filter((name) => !before.has(name)))],
    rewroteFlows: [...new Set(claimed.filter((name) => before.has(name)))],
  };
}

/**
 * Why a drive must not be replayed into a verdict, or undefined when it may. A drive the platform
 * cut off (credits gone: 402 needs_card) had saved one partial flow, and replaying it printed PASS
 * with no word about the credits. The one test both CLI explore paths answer through.
 */
export function cutOffReason(drive: { stopReason?: unknown; error?: unknown }): string | undefined {
  if (StopReason.BROKEN !== drive.stopReason && StopReason.STOPPED !== drive.stopReason)
    return undefined;
  const why =
    'string' === typeof drive.error && 0 < drive.error.length
      ? drive.error
      : StopReason.STOPPED === drive.stopReason
        ? 'autonomous driving was switched off.'
        : 'the drive broke.';
  return `The drive stopped before it finished: ${why} Nothing was proved; what it saved stays, and the next run replays it.`;
}

/** The Agent Log's last line for a drive the platform cut off: its reason, and that it proved nothing. */
export const msgDriveCutOff = (error: string | undefined): string =>
  `Harness stopped before it finished, so nothing is proved: ${error ?? 'the drive broke.'}`;

/**
 * Close and save whatever recording the drive left open.
 *
 * The driver reserves turns for its own teardown, which covers the ordinary ending. It does NOT
 * cover a drive that broke, or one whose model went quiet, or one cut off by a budget the caller
 * shortened — and in every one of those the app really was driven and the record of it is thrown
 * away. Measured before this existed: a 24-step journey through a real dashboard, saved nothing.
 *
 * Failures are swallowed on purpose. This is a last chance, not a checkpoint: if the recording was
 * already closed the stop is refused and there is nothing to do, and a drive must not fail at the
 * finish line because the thing it was trying to rescue did not need rescuing.
 */
/**
 * What a banked recording says it was for: the persona the caller named, when there was one.
 *
 * It used to be "Autonomous drive of X, banked after the run ended" whatever the caller asked for,
 * so a replay could never say which journey the flow was meant to prove.
 */
export function bankedIntent(
  persona: string | undefined,
  open: string,
  /** The journey the drive was for, when no persona was named. */
  journey?: string,
): string {
  const named = (persona ?? journey)?.trim();
  return named !== undefined && 0 < named.length
    ? named
    : `Exploring the app, recorded as ${open} and saved after the run ended.`;
}

export async function bankOpenRecording(
  toolset: HarnessToolset,
  drive: HarnessResult,
  persona: string | undefined,
  journey?: string,
): Promise<ToolOutcome[]> {
  const open = openRecordingName(drive.toolCalls);
  if (open === undefined) return [];
  const args = { flowName: open, intent: bankedIntent(persona, open, journey) };
  try {
    await toolset.invoke(ReticleTool.RECORD, { action: 'stop', recordingName: open });
    const result = await toolset.invoke(ReticleTool.FLOW_SAVE, args);
    // Returned so the save is this drive's own, as a save the model made is.
    return [{ id: 'bank', name: ReticleTool.FLOW_SAVE, args, result, isError: false }];
  } catch {
    /* last chance, not a checkpoint */
    return [];
  }
}

/** The recording started and never stopped, if there is one. Exported because it is the decision. */
export function openRecordingName(toolCalls: readonly ToolOutcome[]): string | undefined {
  let open: string | undefined;
  for (const call of toolCalls) {
    if (ReticleTool.RECORD !== call.name) continue;
    const args = asRecord(call.args);
    const name = args['recordingName'];
    if ('string' !== typeof name) continue;
    if ('start' === args['action'] && !call.isError) open = name;
    if ('stop' === args['action'] && name === open) open = undefined;
  }
  return open;
}

/**
 * Read the project's own record of what it does and what is proved about it.
 *
 * No browser, no model, no source. A failure here is "nothing is recorded yet", which is the
 * ordinary state of a new project and not a reason to refuse to drive — so it answers an empty
 * plan rather than throwing.
 */
export async function readFlows(deps: ToolDeps): Promise<FlowFile[]> {
  const flows: FlowFile[] = [];
  try {
    for (const name of await deps.flows.list()) {
      const loaded = await deps.flows.load(name);
      if (loaded.ok) flows.push(loaded.value);
    }
  } catch {
    // An unreadable store plans from what it could read, as `readPlan` does.
  }
  return flows;
}

export async function readPlan(deps: ToolDeps, sessionId?: string): Promise<HarnessPlan> {
  try {
    const flows = await readFlows(deps);
    const root = sessionRoot(deps, sessionId);
    const contract = await readContract(deps.fs, root);
    const project = await projectForRoot(deps, root).read();
    return buildHarnessPlan(
      buildDomainModel(
        flows,
        contract.ok ? contract.capabilities : null,
        project.ok ? project.file.runs : [],
      ),
    );
  } catch {
    return {
      steps: [],
      summary: 'The project record could not be read; driving without a plan.',
      vocabulary: [],
    };
  }
}

export function pinned(options: ExploreOptions): { sessionId?: string } {
  return options.sessionId === undefined ? {} : { sessionId: options.sessionId };
}

/**
 * The driver: the platform's Harness, which decides every step on its side while this machine
 * executes. There is no other: the decisions, the models and the planning run only on the platform.
 */
export function buildDriver(
  env: Record<string, string | undefined>,
  maxSteps: number,
  plan: HarnessPlan,
  requested?: string,
  persona?: string,
  /** A goal driven with no persona: it names the drive's flows as a persona would. */
  journey?: string,
  /** The survey of the app, which the platform's engine looks goals up in. */
  siteMap?: HarnessMap,
): { driver: ModelDriver; name: string } {
  if (requested !== undefined && SERVER_DRIVER !== requested)
    throw new Error(msgUnknownDriver(requested));
  const platform = serverOptionsFromEnv(env);
  if (platform === undefined) throw new HarnessNotLinkedError();
  return {
    driver: serverDriver({
      ...platform,
      ...(persona === undefined ? {} : { persona }),
      ...(journey === undefined ? {} : { journey }),
      plan: planAsText(plan),
      planSteps: plan.steps,
      vocabulary: plan.vocabulary,
      maxSteps,
      ...(siteMap === undefined ? {} : { siteMap: mapForPlatform(siteMap) }),
      // Secret fields fill from the drive's own env: a persona's credentials ride in it.
      env,
    }),
    name: SERVER_DRIVER,
  };
}
