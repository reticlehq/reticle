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
import { ReticleTool } from '@reticlehq/core';
import { stepCountSchema } from './args/numeric-bounds.js';
import type { ToolDef, ToolDeps } from './tools.js';
import { exploreApp, harnessAvailable, MSG_NO_HARNESS_KEY } from './harness-explore.js';
import { StopReason } from '../../features/harness/harness.js';

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
      steps: z.number(),
      savedFlows: z.array(z.string()),
      /** The model's own account of what it drove. NOT a verdict — the flows are the evidence. */
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
      if (!harnessAvailable(process.env)) throw new Error(MSG_NO_HARNESS_KEY);
      const persona = args['persona'];
      const maxSteps = args['maxSteps'];
      const sessionId = args['sessionId'];
      const { drive, savedFlows } = await exploreApp(deps, process.env, {
        ...('string' === typeof persona ? { focus: persona } : {}),
        ...('number' === typeof maxSteps ? { maxSteps } : {}),
        ...('string' === typeof sessionId ? { sessionId } : {}),
      });
      return {
        stopReason: drive.stopReason,
        steps: drive.steps,
        savedFlows: [...savedFlows],
        summary: drive.summary,
        ...(drive.error === undefined ? {} : { error: drive.error }),
        usage: drive.usage,
        ...(0 === savedFlows.length ? { note: NOTHING_RECORDED[drive.stopReason] } : {}),
      };
    },
  },
];

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
