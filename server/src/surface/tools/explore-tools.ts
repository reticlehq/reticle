/**
 * `reticle_verify { action: "explore" }` — hand the driving back to Reticle.
 *
 * The tool exists because of where the cost of a verification actually sits. An agent that drives an
 * app itself pays for every snapshot, every act result and every observation in ITS OWN context, on
 * every subsequent turn, and then pays again on the next run because nothing was recorded. This call
 * moves the whole drive into the daemon, where a small model does it against the same tool surface,
 * and hands back a few lines: what was driven, and which flows now exist.
 *
 * Those flows are the point. From the second run onwards `reticle_verify { action: "flows" }` replays
 * them deterministically with no model in the loop at all.
 */

import { HarnessRunReason } from '@reticlehq/core/telemetry';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { unprovedGoals } from '@/features/harness/goals.js';
import { ReticleEnv, ReticleTool, asRecord } from '@reticlehq/core';
import { stepCountSchema } from './args/numeric-bounds.js';
import type { ToolCall, ToolDef, ToolDeps } from './tool-kit.js';
import {
  DriveOrigin,
  DriveRefusedError,
  DriveStatus,
  POLL_WAIT_DEFAULT_S,
  awaitDrive,
  driveRecord,
  runningDrive,
  sayToDrive,
  startDrive,
  stillRunning,
  stopDrive,
  type DriveControl,
  type DriveRecord,
} from '@/features/harness/drive-runs.js';
import {
  fetchPlatformRun,
  platformRunAnswer,
} from '@/features/harness/platform/platform-drives.js';
import { serverOptionsFromEnv } from '@/features/harness/platform/server-driver.js';
import { reportPlanBlocked, savedPlanDrivesNothing } from '@/features/harness/platform/script.js';
import { harnessRunId } from '@/judgement/runs/drive-run.js';
import { DRIVE_RECORD_SUFFIX, reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import { RESULT_FIELD, exploreResult, resultField } from './reticle-result.js';
import { runTool } from './invoke-tool.js';
import {
  harnessRunSource,
  reportHarnessBlocked,
  reportHarnessRun,
} from '@/telemetry/harness-run.js';
import { driveVerdict, type RemoteDriveOutcome } from '@/features/harness/platform/remote-drive.js';
import {
  harnessStartRefusal,
  firstLine,
  exploreApp,
  harnessAvailable,
  withLinkedCredential,
  HarnessNotLinkedError,
} from './harness-explore.js';
import { EXPLORE_NEEDS } from '@/features/harness/drivers.js';
import {
  checkTally,
  describeDrive,
  replayedFlows,
  runProved,
} from '@/features/harness/drive-report.js';
import { StopReason, type HarnessResult } from '@/features/harness/harness.js';
import type { ExploreResult } from './harness-explore.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  'object' === typeof v && null !== v && !Array.isArray(v);

export const WAIT_MAX_S = 240;

export const EXPLORE_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.VERIFY_EXPLORE,
    description:
      'Drive the app yourself? Do not — call this instead. The Reticle Harness drives it through this same tool surface (it decides on the Reticle platform, this daemon executes each step), records what it drove as saved flows, and answers in a few lines instead of a context full of snapshots: within `wait` seconds, the result or { status: "running", runId } to poll with `runId`. Never start a second. Pass `persona` to say who to be or what to accomplish ("a returning customer checking out", "an admin revoking a seat") and it completes that whole journey rather than clicking at random. The saved flows are the point: from the next run on, reticle_verify { action: "flows" } replays them deterministically with NO model in the loop. DESTRUCTIVE — it really drives the app, and it spends credits. ' +
      EXPLORE_NEEDS,
    inputSchema: {
      persona: z
        .string()
        .optional()
        .describe(
          'The journey in plain words; "quoted text" must show at the end. Outcome goes in `expect`.',
        ),
      expect: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Predicate it must end in (route, net, state), asserted after.'),
      maxSteps: stepCountSchema
        .optional()
        .describe('Ceiling on model turns; the drive is graded however it ends.'),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
        ),
      driveId: z.string().optional().describe('The drive id an explore call answered with.'),
      wait: z.number().min(0).max(WAIT_MAX_S).optional().describe('Seconds; default 50.'),
      runId: z
        .string()
        .optional()
        .describe('The run id an explore call answered with; pass it to poll that run.'),
      planId: z.string().optional().describe('Run a plan saved on the dashboard, as it stands.'),
      stop: z.boolean().optional().describe('With runId: stop that Harness run.'),
      say: z.string().optional().describe('With runId: a note to the running Harness.'),
    },
    // Everything the handler returns has to be declared, or a schema-aware client never sees it.
    // Optional throughout: a drive still running answers only its status, id and progress.
    outputSchema: {
      /** running | done | stopped | broken. */
      status: z.string().optional(),
      /** The drive's run (`harness-<uuid>`), known from the moment it starts. Poll with it. */
      runId: z.string().optional(),
      /** The drive's latest step or narrated line, while it runs. */
      lastLine: z.string().optional(),
      /** The call that reads this drive again. */
      next: z.object({ action: z.string(), runId: z.string() }).optional(),
      /** Seconds since the drive started, while it runs. */
      elapsedS: z.number().optional(),
      /** While it runs: poll again. Once it ended with a failed check: fix the code, then drive again. */
      instruction: z.string().optional(),
      stopReason: z.string().optional(),
      /** Which driver actually drove, so a comparison can never misattribute its own result. */
      driver: z.string().optional(),
      steps: z.number().optional(),
      savedFlows: z.array(z.string()).optional(),
      /** Flows that already existed and were driven and written again. A second run's ordinary result. */
      rewroteFlows: z.array(z.string()).optional(),
      /** Saved flows with no step that asserts anything: their replay verifies nothing. */
      unverifiedFlows: z.array(z.string()).optional(),
      /** Whether the drive ran at least one check. A drive that did not proved nothing. */
      proved: z.boolean().optional(),
      /**
       * Whether every journey reached its goal, as the platform judged when the drive finished.
       * Absent when no journey's goal was judged. Checks that held are not the goal reached.
       */
      goalMet: z.boolean().optional(),
      /** How the drive's checks came out, one per control and claim at its worst. */
      checks: z.object({ held: z.number(), failed: z.number(), undecided: z.number() }).optional(),
      /** The runs this drive syncs as (`harness-<uuid>`): what the platform links its check to. */
      runIds: z.array(z.string()).optional(),
      /** The run's page on the dashboard, when the project is linked. Give it to the user. */
      runUrl: z.string().optional(),
      /** The saved plan this run drove: the dashboard keeps it, edits it and runs it again. */
      planId: z.string().optional(),
      planUrl: z.string().optional(),
      /** The credits the platform says this run spent. */
      creditsSpent: z.number().optional(),
      /** One verdict per requested goal, checked by the harness itself. Only `yes` is proved. */
      goals: z
        .array(z.object({ text: z.string(), verified: z.string(), reason: z.string().optional() }))
        .optional(),
      /**
       * What the drive set out to do, read from `.reticle` BEFORE it started — every recorded
       * journey with the consequence that must still hold, and the declared intent nobody has
       * tested. Returned so the caller can see the drive was aimed rather than wandering.
       */
      plan: z.object({ summary: z.string(), steps: z.array(z.unknown()) }).optional(),
      /**
       * What the drive did, derived from the calls it made and the verdicts the engine returned.
       *
       * Not the driver's narration. A driver that cannot write a sentence used to leave this empty,
       * and a driver that can is the one witness with a reason to round "unknown" up to "worked".
       */
      summary: z.string().optional(),
      /**
       * The driver's own account, alone. The platform's driver says here why a drive checked nothing
       * at its end, which a caller that only shows the verdict otherwise cannot tell anybody.
       */
      driverAccount: z.string().optional(),
      /**
       * The platform's own failed checks, verbatim: what was expected, what was observed, on which
       * request. The fix request quotes them, so the agent knows exactly what to fix.
       */
      findings: z.array(z.string()).optional(),
      /** Present when the drive broke: a model that would not answer, a wedged browser. */
      error: z.string().optional(),
      /** What the drive cost, cache hits included, so an expensive run is visible rather than felt. */
      usage: z
        .object({
          input: z.number(),
          output: z.number(),
          cacheRead: z.number(),
          cacheWrite: z.number(),
        })
        .optional(),
      /** Said out loud when a drive recorded nothing, because that is not a verified app. */
      note: z.string().optional(),
      /**
       * Each journey of a platform plan and how it ended. Only `passed` is proved. `by`: its saved
       * flows replayed (no model) or the model drove it; `tokens`: what the model spent on it.
       */
      [RESULT_FIELD]: z.string().optional(),
      journeys: z
        .array(
          z.object({
            title: z.string(),
            status: z.string(),
            by: z.string().optional(),
            tokens: z.number().optional(),
          }),
        )
        .optional(),
    },
    handler: (deps: ToolDeps, args: Record<string, unknown>, call?: ToolCall) =>
      answerExplore(deps, args, call, exploreDrive),
  },
];

const MS_PER_S = 1000;

export const MSG_ALREADY_DRIVING =
  'A Harness drive is already running on this app; this is that drive. Poll it by runId; do not start another.';
const msgNoDrive = (runId: string): string =>
  `No Harness drive ${runId} on this machine, and no linked platform to ask for it.`;

/** One drive, run to its end: the tool's own full answer, and how it ended. */
export type ExploreDrive = (
  deps: ToolDeps,
  env: Record<string, string | undefined>,
  args: Record<string, unknown>,
  harness: string,
  control: DriveControl,
) => Promise<{ status: DriveStatus; result: Record<string, unknown> }>;

const str = (v: unknown): string | undefined => ('string' === typeof v ? v : undefined);

/**
 * Start a drive and wait on it for a while, or poll, stop or speak to one by `runId`.
 *
 * The drive itself never runs inside the call: it is started in the registry and the call waits up
 * to `wait` seconds, so a client's timeout loses nothing. A second start on the same app answers
 * with the drive already running rather than paying for another.
 */
export async function answerExplore(
  deps: ToolDeps,
  args: Record<string, unknown>,
  call: ToolCall | undefined,
  drive: ExploreDrive,
): Promise<unknown> {
  const wait = args['wait'];
  const waitMs =
    MS_PER_S *
    Math.min(WAIT_MAX_S, Math.max(0, 'number' === typeof wait ? wait : POLL_WAIT_DEFAULT_S));
  const sessionId = str(args['sessionId']);
  const asked = str(args['runId']);
  if (asked !== undefined) {
    if (true === args['stop']) stopDrive(asked);
    const say = str(args['say']);
    if (say !== undefined) sayToDrive(asked, say);
    return answerDrive(deps, asked, waitMs, call, sessionId, false);
  }
  const running = runningDrive(sessionId);
  if (running !== undefined) {
    const answer = await answerDrive(deps, running.harnessRun, waitMs, call, sessionId, false);
    return { ...asRecord(answer), note: MSG_ALREADY_DRIVING };
  }
  // The credential `reticle link` already filed counts as configured, so somebody who has
  // signed in and linked does not also have to export a key by hand.
  const driveId = args['driveId'];
  const env = {
    // The driven tab's project: the plan it saves and the runs it syncs land in one place.
    ...(await withLinkedCredential(deps, process.env, { sessionId })),
    // Billed to the one free drive the platform granted, never to another.
    ...('string' === typeof driveId ? { [ReticleEnv.DRIVE_ID]: driveId } : {}),
  };
  // The build check first: it is local, and the one thing to fix before anything else matters.
  // Not for a saved plan that only replays flows (no model turn to guard), and a plan it refuses
  // is told so, so the plan's history records the attempt.
  const planId = str(args['planId']);
  const platform = serverOptionsFromEnv(env);
  const replayOnly =
    planId !== undefined &&
    platform !== undefined &&
    (await savedPlanDrivesNothing(platform, planId));
  // In-process callers name their origin. Over MCP nothing can (the schema does not carry it), and
  // a granted free drive with no origin is `reticle try`'s: the HUD's own grant says HUD.
  const origin =
    Object.values(DriveOrigin).find((o) => o === args['origin']) ??
    ('string' === typeof driveId ? DriveOrigin.TRY : DriveOrigin.AGENT);
  // Hosted: the platform drives (the only driver this build ships), as opposed to an injected one.
  const runStart = {
    source: harnessRunSource(origin, planId),
    hosted: platform !== undefined,
  };
  const locked = replayOnly ? undefined : await harnessStartRefusal(deps, sessionId);
  if (locked !== undefined) {
    reportHarnessBlocked(runStart, locked.reason);
    if (planId !== undefined && platform !== undefined)
      await reportPlanBlocked(platform, planId, firstLine(locked.text));
    throw new Error(locked.text);
  }
  if (!harnessAvailable(env)) {
    reportHarnessBlocked(runStart, HarnessRunReason.NOT_LINKED);
    throw new HarnessNotLinkedError();
  }
  const harness = randomUUID();
  const runId = harnessRunId(harness);
  if (runId === undefined) throw new Error(`could not name a run for drive ${harness}`);
  startDrive({
    harness,
    runId,
    origin,
    ...(sessionId === undefined ? {} : { sessionId }),
    now: deps.now,
    persist: (record) => writeDriveFile(deps, sessionId, record),
    run: (control) =>
      reportHarnessRun(
        runStart,
        () => drive(deps, env, args, harness, control),
        (error) => error instanceof DriveRefusedError,
      ),
  });
  // A drive refused before it began (switched off, unentitled) is still a refusal to the caller.
  return answerDrive(deps, runId, waitMs, call, sessionId, true);
}

/** Wait, then answer with the drive as it stands: running, its full result, or why it broke. */
async function answerDrive(
  deps: ToolDeps,
  runId: string,
  waitMs: number,
  call: ToolCall | undefined,
  sessionId: string | undefined,
  refuseBroken: boolean,
): Promise<unknown> {
  const progress = call?.progress;
  await awaitDrive(
    runId,
    waitMs,
    call?.signal,
    progress === undefined ? undefined : (r) => progress(r.steps, r.lastLine),
  );
  const record = driveRecord(runId) ?? (await readDriveFile(deps, sessionId, runId));
  if (record === undefined) return fromPlatform(deps, runId);
  if (DriveStatus.RUNNING === record.status) {
    const elapsedS = Math.max(0, Math.round((deps.now() - record.startedAt) / MS_PER_S));
    return {
      status: record.status,
      runId,
      steps: record.steps,
      lastLine: record.lastLine,
      elapsedS,
      next: { action: 'explore', runId },
      instruction: stillRunning(runId, record.steps, elapsedS),
    };
  }
  if (record.result !== undefined) {
    const fix = fixRequest(record.result);
    return {
      status: record.status,
      runId,
      ...record.result,
      ...(fix === undefined ? {} : { instruction: fix }),
    };
  }
  if (refuseBroken && record.error !== undefined) throw new Error(record.error);
  return { status: record.status, runId, steps: record.steps, error: record.error ?? 'no result' };
}

/**
 * What a finished drive asks of the agent that reads it: a failed check is a defect to fix, and the
 * fix is proved only when the same drive runs again. Without it the agent read "1 failed" and stopped.
 */
export function fixRequest(result: Record<string, unknown>): string | undefined {
  const failed = asRecord(result['checks'])['failed'];
  const findings = Array.isArray(result['findings'])
    ? result['findings'].filter((f): f is string => 'string' === typeof f)
    : [];
  const rerun =
    'Fix the code, then start the same drive again (the same persona or planId) to verify the fix. ' +
    'Do not report it fixed before that drive passes.';
  if (0 < findings.length) return `The Harness found a defect: ${findings.join(' ')} ${rerun}`;
  if ('number' === typeof failed && failed >= 1)
    return (
      `The Harness found a defect: ${String(failed)} check${1 === failed ? '' : 's'} failed. Read ` +
      `\`summary\` and \`goals\` for what failed. ${rerun}`
    );
  // A drive that ran to its end and still missed its goal is not a pass either: on the broken
  // checkout every check held while the order went out at full price. It is a lead, not a verdict,
  // so the agent is asked to find out which, not told there is a defect.
  if (StopReason.FINISHED === result['stopReason'] && false === result['goalMet'])
    return (
      'The Harness drive did not reach its goal, so nothing is proved. Read `summary` and check the ' +
      'outcome the goal names (for example the request body with reticle_observe). If it shows a ' +
      'defect, fix the code, then start the same drive again (the same persona or planId) to verify ' +
      'the fix. Do not report it fixed before that drive passes.'
    );
  return undefined;
}

/** How the platform opens a check it failed in a drive's summary: "Not proved: <what, where>". */
const PLATFORM_FAILED = /Not proved: ([^\n]+)/g;
/** How the answer's summary says one of them. */
const FINDING_LEAD = 'Failed on the platform:';

/**
 * The platform's failed checks, each verbatim, read from its run summary. A plan run leaves the
 * driver's account out of the answer, and with it went "totalCents 16700, the claim says 13360".
 */
export function platformFindings(summary: string): string[] {
  return [...summary.matchAll(PLATFORM_FAILED)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1].trim()],
  );
}

/** A run this machine no longer holds, from the platform it synced to. */
async function fromPlatform(deps: ToolDeps, runId: string): Promise<unknown> {
  const platform = serverOptionsFromEnv(await withLinkedCredential(deps, process.env));
  if (platform === undefined) throw new Error(msgNoDrive(runId));
  const got = await fetchPlatformRun(platform, runId);
  if ('error' in got) throw new Error(got.error);
  return platformRunAnswer(runId, got.run);
}

/** Where the drive's record lives: its session's own project, never wherever the daemon started. */
function driveFile(deps: ToolDeps, sessionId: string | undefined, runId: string): string {
  return join(reticleDirPaths(sessionRoot(deps, sessionId)).runs, `${runId}${DRIVE_RECORD_SUFFIX}`);
}

/** `.reticle/runs/<run>.drive.json`: a new session or a restarted daemon can still read the drive. */
async function writeDriveFile(
  deps: ToolDeps,
  sessionId: string | undefined,
  record: DriveRecord,
): Promise<void> {
  const path = driveFile(deps, sessionId, record.harnessRun);
  await deps.fs.mkdir(join(path, '..'));
  await deps.fs.writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

async function readDriveFile(
  deps: ToolDeps,
  sessionId: string | undefined,
  runId: string,
): Promise<DriveRecord | undefined> {
  try {
    const parsed = asRecord(JSON.parse(await deps.fs.readFile(driveFile(deps, sessionId, runId))));
    const status = Object.values(DriveStatus).find((s) => s === parsed['status']);
    if (status === undefined || runId !== parsed['harnessRun']) return undefined;
    // A record left `running` by a daemon that has since gone will never finish.
    const lost = DriveStatus.RUNNING === status;
    return {
      ...(parsed as unknown as DriveRecord),
      status: lost ? DriveStatus.BROKEN : status,
      ...(lost ? { error: MSG_DRIVE_LOST } : {}),
    };
  } catch {
    return undefined;
  }
}

const MSG_DRIVE_LOST =
  'The daemon that ran this drive stopped before it finished; what it drove up to then is kept.';

/** How a drive ended, as the registry records it. */
function statusOf(stopReason: StopReason): DriveStatus {
  if (StopReason.STOPPED === stopReason) return DriveStatus.STOPPED;
  if (StopReason.BROKEN === stopReason) return DriveStatus.BROKEN;
  return DriveStatus.DONE;
}

/** The shipped drive: `exploreApp`, steered by the registry, reported as the tool's answer. */
const exploreDrive: ExploreDrive = async (deps, env, args, harness, control) => {
  const persona = args['persona'];
  // Only a run a person started may carry the acknowledgement; an agent's drive keeps the guard.
  const confirmDangerous =
    true === args['confirmDangerous'] &&
    DriveOrigin.AGENT !==
      (Object.values(DriveOrigin).find((o) => o === args['origin']) ?? DriveOrigin.AGENT);
  const maxSteps = args['maxSteps'];
  const sessionId = args['sessionId'];
  const expect = args['expect'];
  const planId = args['planId'];
  const explored = await exploreApp(deps, env, {
    ...('string' === typeof planId ? { planId } : {}),
    ...(confirmDangerous ? { confirmDangerous } : {}),
    ...('string' === typeof persona ? { focus: persona } : {}),
    ...('number' === typeof maxSteps ? { maxSteps } : {}),
    ...('string' === typeof sessionId ? { sessionId } : {}),
    ...(isRecord(expect) ? { expect } : {}),
    harnessId: harness,
    stopped: control.stopped,
    inbox: control.takeSaid,
  });
  const result = exploreReport(explored);
  return {
    status: statusOf(explored.drive.stopReason),
    result: {
      ...result,
      ...resultField(() =>
        exploreResult(sessionRoot(deps, 'string' === typeof sessionId ? sessionId : undefined), {
          checks: checkTally(explored.drive.toolCalls),
          goals: explored.goals,
          ...(explored.drive.goalMet === undefined ? {} : { goalMet: explored.drive.goalMet }),
          ...(explored.journeys === undefined ? {} : { journeys: explored.journeys }),
          ...(explored.runIds === undefined ? {} : { runIds: explored.runIds }),
        }),
      ),
    },
  };
};

/** The tool's answer for a finished drive. */
export function exploreReport(explored: ExploreResult): Record<string, unknown> {
  const {
    drive,
    savedFlows,
    rewroteFlows,
    unverifiedFlows,
    driverName,
    plan,
    goals,
    planLines,
    runIds,
    runUrl,
    journeys,
    planId,
    planUrl,
    disparity,
  } = explored;
  const checks = checkTally(drive.toolCalls);
  const findings = platformFindings(drive.summary);
  return {
    stopReason: drive.stopReason,
    ...(0 === findings.length ? {} : { findings }),
    driver: driverName,
    steps: drive.steps,
    savedFlows: [...savedFlows],
    rewroteFlows: [...rewroteFlows],
    unverifiedFlows: [...unverifiedFlows],
    // The headline's own word, so the answer never says NOT PROVED beside `proved: true`.
    proved: runProved(checks, drive.goalMet, journeys),
    checks,
    ...(drive.goalMet === undefined ? {} : { goalMet: drive.goalMet }),
    ...(runIds === undefined ? {} : { runIds: [...runIds] }),
    // Where the user sees this run, and what it cost: the two things an agent is asked after a run.
    ...(runUrl === undefined ? {} : { runUrl }),
    ...(planId === undefined ? {} : { planId }),
    ...(planUrl === undefined ? {} : { planUrl }),
    ...(drive.creditsSpent === undefined ? {} : { creditsSpent: drive.creditsSpent }),
    ...(journeys === undefined
      ? {}
      : {
          journeys: journeys.map((j) => ({
            title: j.title,
            status: j.status,
            ...(j.by === undefined ? {} : { by: j.by }),
            ...(j.tokens === undefined ? {} : { tokens: j.tokens }),
          })),
        }),
    goals: [...goals],
    // Each goal the agent also judged, compared: agent proved and Harness could not find is a
    // discoverability finding, filed on the platform as its own kind.
    ...(disparity === undefined ? {} : { disparity: [...disparity] }),
    // The local plan only when nothing else planned the drive. Beside a platform plan's journeys it
    // was a second, unrelated plan — fifteen replays of other people's flows — in the same answer.
    ...(journeys === undefined ? { plan: { summary: plan.summary, steps: [...plan.steps] } } : {}),
    // Derived, not narrated. The driver's own account stays out of it, in `driverAccount`: it
    // named flows it never saved ("saved 1 flow(s)" beside "its recording was not saved"), and a
    // summary must never contradict itself.
    summary: [
      ...(planLines ?? []),
      describeDrive(
        drive.toolCalls,
        [...savedFlows, ...rewroteFlows],
        unverifiedFlows,
        drive.goalMet,
        journeys,
      ),
      ...[unprovedGoals(goals)].filter((line): line is string => line !== undefined),
      ...findings.map((finding) => `${FINDING_LEAD} ${finding}`),
    ].join('\n'),
    // Not beside a platform plan: its lanes' accounts count saves the platform asked for ("saved 3
    // flow(s)") where `savedFlows` lists what is on disk, and an answer has one count. Each journey's
    // ending is in `journeys`, and the end state in `goals`.
    ...(0 === drive.summary.length || journeys !== undefined
      ? {}
      : { driverAccount: drive.summary }),
    ...(drive.error === undefined ? {} : { error: drive.error }),
    usage: drive.usage,
    // The note only fires when the drive left NOTHING behind. A rewritten flow is a flow: it
    // replays, it proves what it asserts, and telling its author that "nothing will replay" is
    // a lie this tool used to tell on every second run.
    /*
     * The note fires only when the run left NOTHING behind — and a run that REPLAYED left
     * plenty. Sixteen recorded journeys re-proved for zero model tokens is the cheap half of
     * the plan doing its job, and telling its author to "raise maxSteps" reads as a failure.
     */
    // A persona drive's advice: a plan run's journeys already say how each went.
    ...(journeys === undefined &&
    0 === savedFlows.length &&
    0 === rewroteFlows.length &&
    0 === replayedFlows(drive.toolCalls).length
      ? { note: `${NOTHING_RECORDED[drive.stopReason]}${failureDetail(drive)}` }
      : {}),
  };
}

/**
 * The tool failure behind an empty drive, when there was one.
 *
 * "The drive ran out of steps before saving a flow" is true of a drive that explored happily and ran
 * long, and ALSO of one that reached its save and was refused — and those need opposite responses.
 * Without this the two are indistinguishable from outside the daemon, which cost a full debugging
 * session: a driver whose `reticle_record{stop}` was rejected for a missing argument retried until
 * the budget ended, and the only thing the caller ever saw was the advice to raise `maxSteps`.
 */
function failureDetail(drive: HarnessResult): string {
  const failed = drive.toolCalls.filter((call) => call.isError);
  const last = failed[failed.length - 1];
  if (last !== undefined) {
    const message = asRecord(last.result)['error'];
    return ` ${String(failed.length)} tool call(s) failed during the drive; the last was ${last.name}: ${'string' === typeof message ? message : 'no message'}`;
  }
  // Nothing threw, so the interesting case left is a save that was ACCEPTED and wrote nothing —
  // an empty recording reports success, and from outside the daemon that is indistinguishable from
  // a drive that never reached its save at all.
  const saves = drive.toolCalls.filter((call) => ReticleTool.FLOW_SAVE === call.name);
  const save = saves[saves.length - 1];
  if (save !== undefined) {
    const result = asRecord(save.result);
    return ` The flow save was accepted but kept nothing: ${JSON.stringify({ stepCount: result['stepCount'], empty: result['empty'], warning: result['warning'] })}.`;
  }
  return ` The drive never reached a flow save (${String(drive.toolCalls.length)} tool calls made).`;
}

/**
 * What an empty drive means, said rather than left for the caller to infer.
 *
 * A drive that saved no flows is not a verified app, and the four ways of getting there need
 * different answers: a model that finished without recording needs a persona, one that ran out of
 * budget needs more of it, one that stalled needs a look, and a broken one needs its error read.
 */
const NOTHING_RECORDED: Record<StopReason, string> = {
  [StopReason.FINISHED]:
    'The drive finished without saving a flow, so nothing is proved and nothing will replay. Give it a `persona` — a journey to complete — and it will record one.',
  [StopReason.BUDGET]:
    'The drive ran out of steps before saving a flow. Raise `maxSteps`, or give it a narrower `persona` so it spends the budget on one journey.',
  [StopReason.STALLED]:
    'The drive stopped asking for tools without finishing. Nothing was saved, and nothing is proved.',
  [StopReason.BROKEN]: 'The drive broke before saving anything — read `error`. Nothing is proved.',
  [StopReason.STOPPED]:
    'Autonomous driving was switched off before the drive saved anything. Nothing is proved; switch it back on to drive again.',
};

/**
 * The full answer of a drive a start left running: the chat answers once, so it waits for the end.
 * Waited on the registry rather than by polling the tool, which would count every poll as a call.
 */
async function driveToEnd(out: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = out['runId'];
  if (DriveStatus.RUNNING !== out['status'] || 'string' !== typeof runId) return out;
  await awaitDrive(runId, undefined);
  const record = driveRecord(runId);
  if (record?.result !== undefined) return { status: record.status, runId, ...record.result };
  return {
    status: record?.status,
    runId,
    error: record?.error ?? 'the drive ended with no result',
  };
}

/**
 * A drive the platform's chat asked for, run as the very tool an agent would call.
 *
 * Through `runTool`, not a second path to `exploreApp`: a dispatch that skips it is a drive nobody
 * counted, and the chat's answer is then the same derived summary the agent would have read — never
 * a model's account of its own drive.
 */
export async function driveForChat(
  deps: ToolDeps,
  goal: string,
  sessionId?: string,
  planId?: string,
  /** The person who started it acknowledged the saved flows' destructive steps. */
  confirmDangerous?: boolean,
): Promise<RemoteDriveOutcome> {
  const explore = EXPLORE_TOOLS.find((tool) => ReticleTool.VERIFY_EXPLORE === tool.name);
  if (explore === undefined) throw new Error('this build has no Harness drive');
  const out = await driveToEnd(
    asRecord(
      await runTool(explore, deps, {
        // A saved plan carries its own journeys: the request's words are only its label.
        ...(planId === undefined ? { persona: goal } : { planId }),
        origin: DriveOrigin.CHAT,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(true === confirmDangerous ? { confirmDangerous } : {}),
      }),
    ),
  );
  const summary = 'string' === typeof out['summary'] ? out['summary'] : '';
  const error = 'string' === typeof out['error'] ? out['error'] : undefined;
  const note = 'string' === typeof out['note'] ? out['note'] : undefined;
  const goals = Array.isArray(out['goals'])
    ? out['goals'].flatMap((g) => {
        const verified = asRecord(g)['verified'];
        return 'string' === typeof verified ? [{ verified }] : [];
      })
    : [];
  const goalMet = out['goalMet'];
  const tally = asRecord(out['checks']);
  const count = (key: string): number => ('number' === typeof tally[key] ? tally[key] : 0);
  const checks = { held: count('held'), failed: count('failed'), undecided: count('undecided') };
  const runIds = Array.isArray(out['runIds'])
    ? out['runIds'].filter((id): id is string => 'string' === typeof id)
    : [];
  return {
    // Only a drive that ran a check and did not break counts as one that proved anything.
    ok: true === out['proved'] && error === undefined,
    ...(0 === runIds.length ? {} : { runIds }),
    verdict: driveVerdict({
      proved: true === out['proved'],
      checks,
      goals,
      ...(error === undefined ? {} : { error }),
      ...('boolean' === typeof goalMet ? { goalMet } : {}),
    }),
    summary: [summary, note, error === undefined ? undefined : `Error: ${error}`]
      .filter((line): line is string => line !== undefined && 0 < line.length)
      .join('\n'),
  };
}
