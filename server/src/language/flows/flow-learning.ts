import type { ProjectId, FlowReplayResult } from '@reticlehq/core';
import { asString } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { flowsForSession } from './flow-store-for-session.js';
import { replayNamedFlow } from './flow-replay-run.js';

/**
 * Write back what a replay taught the flow, once the replay has finished writing its own.
 *
 * Deliberately OUTSIDE `replayNamedFlow`. Persisting from inside it broke the intent bookkeeping —
 * a replay records the intent it discharged on the same file, and a second writer in the middle of
 * that turned `proved` back into `bound`. The test that caught it is
 * `a passing replay marks the intent proved with the verdict that did it`, and the lesson is
 * general: a read-modify-write layered into someone else's transaction is a rollback wearing an
 * update's clothes.
 *
 * So this runs after the replay has returned and re-reads the flow first, merging only `learned`
 * onto whatever the file now says.
 *
 * Best-effort by construction: a store that refuses the write must not turn a completed replay into
 * a failed one. The verdict is about the app; this is bookkeeping about the flow, and losing a
 * lesson is a smaller loss than losing the run that produced it.
 */
export async function persistLearning(
  deps: ToolDeps,
  args: Record<string, unknown>,
  result: FlowReplayResult,
): Promise<FlowReplayResult> {
  const learned = result.learned;
  if (learned === undefined || 0 === learned.length) return result;
  const name = asString(args['flowName']) ?? '';
  if (0 === name.length) return result;
  try {
    let projectId: ProjectId | undefined;
    try {
      projectId = deps.sessions.resolve(asString(args['sessionId'])).projectId;
    } catch {
      projectId = undefined;
    }
    await flowsForSession(deps, projectId).flows.recordLearned(name, learned, projectId);
  } catch {
    // Bookkeeping only.
  }
  return result;
}

/**
 * Replay a flow AND keep what it learned. The entry point every ordinary replay should use.
 *
 * Every replay path must route through here, not `replayNamedFlow` — promotion needs CONSECUTIVE
 * clean runs, so a path that skips the write-back promotes nothing while still reporting `learned`
 * and `promoted`.
 *
 * Wrapped here rather than inside `replayNamedFlow`, for the reason `persistLearning` above gives:
 * persisting from inside it puts a second writer in the middle of the replay's own intent
 * bookkeeping and turns `proved` back into `bound`.
 *
 * ── WHO MUST NOT USE THIS ───────────────────────────────────────────────────────────────────────
 * Two callers replay deliberately BROKEN conditions and call `replayNamedFlow` directly on purpose:
 *
 * - mutation testing (`flow-mutate-tools.ts`) breaks the app to check the flow notices. Learning
 *   from that teaches the flow about a defect nobody shipped.
 * - the perturbed branch of the seed path slows the network to see what the flow does under stress.
 *   A finding that appears only under perturbation is not a fact about the app.
 *
 * Both write a finding that would then have to STOP appearing to be promoted — so the damage is not
 * a wrong guard today, it is a guard earned against a condition the app is never in.
 */
export async function replayAndLearn(
  deps: ToolDeps,
  /**
   * The tool's args, WHOLE.
   *
   * Narrowed to `{ flowName, sessionId }` in the first draft, which silently dropped
   * `confirmDangerous` — so a replay that had been authorised to drive a destructive control lost
   * that authorisation on its way through here and refused the step. `tools.flow-replay.test.ts`
   * caught it. `seed` and anything added later travel the same path, so the whole object goes.
   */
  args: Record<string, unknown>,
): Promise<FlowReplayResult> {
  return await persistLearning(deps, args, await replayNamedFlow(deps, args));
}
