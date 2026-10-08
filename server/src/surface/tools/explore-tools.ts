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

import { z } from 'zod';
import { unprovedGoals } from '@/features/harness/goals.js';
import { ReticleTool, asRecord } from '@reticlehq/core';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  'object' === typeof v && null !== v && !Array.isArray(v);
import { stepCountSchema } from './args/numeric-bounds.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';
import { runTool } from './invoke-tool.js';
import { driveVerdict, type RemoteDriveOutcome } from '@/features/harness/platform/remote-drive.js';
import {
  exploreApp,
  harnessAvailable,
  withLinkedCredential,
  MSG_NO_HARNESS_KEY,
} from './harness-explore.js';
import { EXPLORE_NEEDS } from '@/features/harness/drivers.js';
import { checkTally, describeDrive, replayedFlows } from '@/features/harness/drive-report.js';
import { StopReason, type HarnessResult } from '@/features/harness/harness.js';

export const EXPLORE_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.VERIFY_EXPLORE,
    description:
      'Drive the app yourself? Do not — call this instead. The Reticle Harness drives it through this same tool surface (it decides on the Reticle platform, this daemon executes each step), records what it drove as saved flows, and answers in a few lines, so the whole drive costs you one tool call instead of a context full of snapshots. Pass `persona` to say who to be or what to accomplish ("a returning customer checking out", "an admin revoking a seat") and it completes that whole journey rather than clicking at random. Returns { stopReason, steps, savedFlows, summary, usage }. The saved flows are the point: from the next run on, reticle_verify { action: "flows" } replays them deterministically with NO model in the loop. DESTRUCTIVE — it really drives the app, and it spends Harness credits. ' +
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
    },
    // Everything the handler returns has to be declared, or a schema-aware client never sees it.
    outputSchema: {
      stopReason: z.string(),
      /** Which driver actually drove, so a comparison can never misattribute its own result. */
      driver: z.string(),
      steps: z.number(),
      savedFlows: z.array(z.string()),
      /** Flows that already existed and were driven and written again. A second run's ordinary result. */
      rewroteFlows: z.array(z.string()),
      /** Saved flows with no step that asserts anything: their replay verifies nothing. */
      unverifiedFlows: z.array(z.string()),
      /** Whether the drive ran at least one check. A drive that did not proved nothing. */
      proved: z.boolean(),
      /**
       * Whether every journey reached its goal, as the platform judged when the drive finished.
       * Absent when no journey's goal was judged. Checks that held are not the goal reached.
       */
      goalMet: z.boolean().optional(),
      /** How the drive's checks came out, one per control and claim at its worst. */
      checks: z.object({ held: z.number(), failed: z.number(), undecided: z.number() }),
      /** The runs this drive syncs as (`harness-<uuid>`): what the platform links its check to. */
      runIds: z.array(z.string()).optional(),
      /** One verdict per requested goal, checked by the harness itself. Only `yes` is proved. */
      goals: z.array(z.object({ text: z.string(), verified: z.string() })),
      /**
       * What the drive set out to do, read from `.reticle` BEFORE it started — every recorded
       * journey with the consequence that must still hold, and the declared intent nobody has
       * tested. Returned so the caller can see the drive was aimed rather than wandering.
       */
      plan: z.object({ summary: z.string(), steps: z.array(z.unknown()) }),
      /**
       * What the drive did, derived from the calls it made and the verdicts the engine returned.
       *
       * Not the driver's narration. A driver that cannot write a sentence used to leave this empty,
       * and a driver that can is the one witness with a reason to round "unknown" up to "worked".
       */
      summary: z.string(),
      /** Present when the drive broke: a model that would not answer, a wedged browser. */
      error: z.string().optional(),
      /** What the drive cost, cache hits included, so an expensive run is visible rather than felt. */
      usage: z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
      }),
      /** Said out loud when a drive recorded nothing, because that is not a verified app. */
      note: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args: Record<string, unknown>) => {
      // The credential `reticle link` already filed counts as configured, so somebody who has
      // signed in and linked does not also have to export a key by hand.
      const env = await withLinkedCredential(deps, process.env);
      if (!harnessAvailable(env)) throw new Error(MSG_NO_HARNESS_KEY);
      const persona = args['persona'];
      const maxSteps = args['maxSteps'];
      const sessionId = args['sessionId'];
      const expect = args['expect'];
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
      } = await exploreApp(deps, env, {
        ...('string' === typeof persona ? { focus: persona } : {}),
        ...('number' === typeof maxSteps ? { maxSteps } : {}),
        ...('string' === typeof sessionId ? { sessionId } : {}),
        ...(isRecord(expect) ? { expect } : {}),
      });
      return {
        stopReason: drive.stopReason,
        driver: driverName,
        steps: drive.steps,
        savedFlows: [...savedFlows],
        rewroteFlows: [...rewroteFlows],
        unverifiedFlows: [...unverifiedFlows],
        proved: drive.proved,
        checks: checkTally(drive.toolCalls),
        ...(drive.goalMet === undefined ? {} : { goalMet: drive.goalMet }),
        ...(runIds === undefined ? {} : { runIds: [...runIds] }),
        goals: [...goals],
        plan: { summary: plan.summary, steps: [...plan.steps] },
        // Derived, not narrated. The driver's own `summary` is appended only when it said
        // something — it is the one part of this a model authored, so it goes last and is labelled.
        summary: [
          ...(planLines ?? []),
          describeDrive(drive.toolCalls, [...savedFlows, ...rewroteFlows], unverifiedFlows),
          ...[unprovedGoals(goals)].filter((line): line is string => line !== undefined),
          ...(0 === drive.summary.length ? [] : [`The driver's own account: ${drive.summary}`]),
        ].join('\n'),
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
        ...(0 === savedFlows.length &&
        0 === rewroteFlows.length &&
        0 === replayedFlows(drive.toolCalls).length
          ? { note: `${NOTHING_RECORDED[drive.stopReason]}${failureDetail(drive)}` }
          : {}),
      };
    },
  },
];

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
): Promise<RemoteDriveOutcome> {
  const explore = EXPLORE_TOOLS.find((tool) => ReticleTool.VERIFY_EXPLORE === tool.name);
  if (explore === undefined) throw new Error('this build has no Harness drive');
  const out = asRecord(
    await runTool(explore, deps, {
      persona: goal,
      ...(sessionId === undefined ? {} : { sessionId }),
    }),
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
