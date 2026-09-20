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
import { ReticleTool, asRecord } from '@reticlehq/core';
import { stepCountSchema } from './args/numeric-bounds.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';
import {
  exploreApp,
  harnessAvailable,
  withLinkedCredential,
  MSG_NO_HARNESS_KEY,
} from './harness-explore.js';
import { DRIVER_NAMES } from '@/features/harness/drivers.js';
import { describeDrive, replayedFlows } from '@/features/harness/drive-report.js';
import { StopReason, type HarnessResult } from '@/features/harness/harness.js';

export const EXPLORE_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.VERIFY_EXPLORE,
    description:
      'Drive the app yourself? Do not — call this instead. A model inside the daemon drives it through this same tool surface, records what it drove as saved flows, and answers in a few lines, so the whole drive costs you one tool call instead of a context full of snapshots. Pass `persona` to say who to be or what to accomplish ("a returning customer checking out", "an admin revoking a seat") and it completes that whole journey rather than clicking at random. Returns { stopReason, steps, savedFlows, summary, usage }. The saved flows are the point: from the next run on, reticle_verify { action: "flows" } replays them deterministically with NO model in the loop. DESTRUCTIVE — it really drives the app, and it spends model budget. Needs ANTHROPIC_API_KEY in the daemon environment.',
    inputSchema: {
      persona: z
        .string()
        .optional()
        .describe(
          'Who to be, or what to accomplish. A journey ("sign up, then invite a teammate") drives far better than no focus at all.',
        ),
      maxSteps: stepCountSchema
        .optional()
        .describe(
          'Ceiling on model turns. Bounds cost, not value — the drive is graded however it ends.',
        ),
      driver: z
        .enum(DRIVER_NAMES)
        .optional()
        .describe(
          'Which model drives. An unconfigured one is an error, never a substitution, so an A/B cannot measure the same driver twice. Omit for the default.',
        ),
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
      const driver = args['driver'];
      const { drive, savedFlows, rewroteFlows, driverName, plan } = await exploreApp(deps, env, {
        ...('string' === typeof persona ? { focus: persona } : {}),
        ...('number' === typeof maxSteps ? { maxSteps } : {}),
        ...('string' === typeof sessionId ? { sessionId } : {}),
        ...('string' === typeof driver ? { driverName: driver } : {}),
      });
      return {
        stopReason: drive.stopReason,
        driver: driverName,
        steps: drive.steps,
        savedFlows: [...savedFlows],
        rewroteFlows: [...rewroteFlows],
        plan: { summary: plan.summary, steps: [...plan.steps] },
        // Derived, not narrated. The driver's own `summary` is appended only when it said
        // something — it is the one part of this a model authored, so it goes last and is labelled.
        summary: [
          describeDrive(drive.toolCalls, [...savedFlows, ...rewroteFlows]),
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
};
