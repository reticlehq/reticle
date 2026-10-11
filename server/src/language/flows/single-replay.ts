/**
 * `reticle_flow_replay`'s answer: one flow replayed, written down as a run, ending with the Reticle
 * result block. The run id is minted first, so each replayed step's screenshot is filed under it.
 */
import { asString, type FlowReplayResult } from '@reticlehq/core';
import { defaultRunId, withShotRun } from '@/judgement/runs/default-run-id.js';
import { persistAndSyncVerificationRun } from '@/judgement/runs/verification-sync.js';
import { rootForTarget, safeSessionTarget } from '@/memory/project/session-root.js';
import { replayResult, resultField } from '@/surface/tools/reticle-result.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { replaySeededOrNot } from './flow-learning.js';

export function replayOneFlow(
  deps: ToolDeps,
  args: Record<string, unknown>,
  appUrl: string | undefined,
): Promise<FlowReplayResult> {
  return withShotRun(defaultRunId(), async (): Promise<FlowReplayResult> => {
    const start = deps.now();
    const replay = await replaySeededOrNot(deps, args, appUrl);
    const durationMs = deps.now() - start;
    const target = safeSessionTarget(deps, asString(args['sessionId']));
    // Written down as a run, and named in the answer: the platform's Re-verify ties its check to
    // it, and a check with no run could never resolve the issue it was for.
    const runId = await persistAndSyncVerificationRun(deps, [{ replay, durationMs }], target);
    return {
      ...replay,
      ...(runId === undefined ? {} : { runId }),
      ...resultField(() => replayResult(rootForTarget(deps, target), replay, durationMs, runId)),
    };
  });
}
