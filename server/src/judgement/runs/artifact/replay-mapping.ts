/**
 * Pure mapping from a flow-replay outcome (the existing reticle_flow_verify machinery) into the
 * verification-run artifact's per-flow shape. DRIFT and ERROR both collapse to FAIL — from a host's
 * perspective a flow that drifted no longer behaves, so it must not read as green. The actionable
 * "why" is lifted from the replay's decision envelope (or its error) into failureReason.
 */

import {
  ReplayStatus,
  RUN_RECORDING_MAX_BYTES,
  RUN_STEP_RESULTS_MAX,
  RUN_TEXT_MAX,
  RunFlowStatus,
  type FlowFile,
  type FlowReplayResult,
  type FlowStepResult,
  type RunFlowResult,
  type RunStepResult,
} from '@reticlehq/core';
import { SUCCESS_STEP_TOOL } from '@/language/flows/flow-success.js';

/** OK → PASS; DRIFT/ERROR → FAIL (a healed flow is produced by the heal path, not plain replay). */
export function runFlowStatusOf(status: ReplayStatus): RunFlowStatus {
  return status === ReplayStatus.OK ? RunFlowStatus.PASS : RunFlowStatus.FAIL;
}

const clip = (text: string): string =>
  text.length > RUN_TEXT_MAX ? `${text.slice(0, RUN_TEXT_MAX - 1)}…` : text;

/** One step as synced: what it did, where, and whether it held. */
function stepResultOf(step: FlowStepResult): RunStepResult {
  return {
    step: step.step,
    anchor: clip(step.anchor),
    ok: step.ok,
    ...(step.page === undefined ? {} : { page: step.page }),
    ...(step.endPage === undefined ? {} : { endPage: step.endPage }),
    ...(step.consequence === undefined ? {} : { consequence: clip(step.consequence) }),
    ...(step.error === undefined ? {} : { error: clip(step.error) }),
    ...(step.drift === undefined ? {} : { drift: step.drift.reasonKind }),
  };
}

/**
 * The flow as recorded, when it is small enough to travel — what lets a teammate replay this run
 * from the cloud. Fill values were already redacted when the flow was saved.
 */
function recordingOf(flow: FlowFile): Pick<RunFlowResult, 'recording' | 'recordingOmitted'> {
  const recording = {
    ...(flow.startPath === undefined ? {} : { startPath: flow.startPath }),
    steps: flow.steps,
  };
  return Buffer.byteLength(JSON.stringify(recording)) > RUN_RECORDING_MAX_BYTES
    ? { recordingOmitted: true }
    : { recording };
}

/** Map one replay (plus its measured duration) into a RunFlowResult for the artifact's flows[]. */
export function mapReplayToFlowResult(
  replay: FlowReplayResult,
  durationMs: number,
  flow?: FlowFile,
): RunFlowResult {
  const status = runFlowStatusOf(replay.status);
  const failureReason =
    status === RunFlowStatus.FAIL
      ? (replay.decision?.whatChanged ??
        replay.decision?.summary ??
        replay.error?.message ??
        'flow failed')
      : undefined;
  // A flow with a success oracle gets a synthetic 'success' step appended by replay; surface its label
  // as the run's `oracle` so the verdict counts this flow as consequence-backed (→ HIGH confidence),
  // not a bare smoke click. Without this, an oracle-backed pass reads as MEDIUM and undersells itself.
  const oracle = replay.steps.find((s) => s.tool === SUCCESS_STEP_TOOL)?.anchor;
  return {
    name: replay.name,
    status,
    steps: replay.steps.length,
    durationMs,
    ...(oracle !== undefined ? { oracle } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
    ...(0 === replay.steps.length
      ? {}
      : { stepResults: replay.steps.slice(0, RUN_STEP_RESULTS_MAX).map(stepResultOf) }),
    ...(flow === undefined ? {} : recordingOf(flow)),
  };
}
