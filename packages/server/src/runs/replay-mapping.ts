/**
 * Pure mapping from a flow-replay outcome (the existing iris_flow_verify machinery) into the
 * verification-run artifact's per-flow shape. DRIFT and ERROR both collapse to FAIL — from a host's
 * perspective a flow that drifted no longer behaves, so it must not read as green. The actionable
 * "why" is lifted from the replay's decision envelope (or its error) into failureReason.
 */

import {
  ReplayStatus,
  RunFlowStatus,
  type FlowReplayResult,
  type RunFlowResult,
} from '@syrin/iris-protocol';

/** OK → PASS; DRIFT/ERROR → FAIL (a healed flow is produced by the heal path, not plain replay). */
export function runFlowStatusOf(status: ReplayStatus): RunFlowStatus {
  return status === ReplayStatus.OK ? RunFlowStatus.PASS : RunFlowStatus.FAIL;
}

/** Map one replay (plus its measured duration) into a RunFlowResult for the artifact's flows[]. */
export function mapReplayToFlowResult(replay: FlowReplayResult, durationMs: number): RunFlowResult {
  const status = runFlowStatusOf(replay.status);
  const failureReason =
    status === RunFlowStatus.FAIL
      ? (replay.decision?.whatChanged ??
        replay.decision?.summary ??
        replay.error?.message ??
        'flow failed')
      : undefined;
  return {
    name: replay.name,
    status,
    steps: replay.steps.length,
    durationMs,
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}
