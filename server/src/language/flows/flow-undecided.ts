/**
 * Replay answers that decided nothing about the app.
 *
 * A step can run and still leave its answer unknown: its target was one no person could reach, or
 * its expectation came back inconclusive (the page did not return the whole text it was asked to
 * judge). Neither is a pass, and neither is the app's failure. A flow whose only drifts are these is
 * `unverifiable`; read as drift, a correct app replayed as failed.
 */
import {
  DriftReason,
  ReplayStatus,
  expectLabel,
  type Drift,
  type FlowReplayResult,
  type FlowStep,
  type FlowStepResult,
} from '@reticlehq/core';
import { SESSION_DISCONNECTED_REASON } from '@/portal/session/facts/session-replaced.js';

/** Drifts that decided nothing about the app: the step ran, and its answer could not be had. */
const UNDECIDED_DRIFTS: ReadonlySet<string> = new Set([
  DriftReason.TARGET_UNREACHABLE,
  DriftReason.EXPECT_UNDECIDED,
]);

/**
 * The honest answer when a step acted on a target no person could have clicked (covered, of no
 * size, off screen). The replay stopped there, and nothing about the app was decided: undecided as a
 * whole, with the cause and the fix, as a live act answers it. Read as a drift, the suite counted it
 * as a failed flow ("Reticle result: failed") on an app that may be fine.
 */
export function unreachableTargetResult(
  name: string,
  steps: readonly FlowStepResult[],
): FlowReplayResult | undefined {
  const step = steps.find((s) => UNDECIDED_DRIFTS.has(s.drift?.reasonKind ?? ''));
  if (step?.drift === undefined) {
    return undefined;
  }
  // A sweep runs on past an undecided step. A real failure later in it stays a failure.
  if (steps.some((s) => s.drift !== undefined && !UNDECIDED_DRIFTS.has(s.drift.reasonKind))) {
    return undefined;
  }
  return {
    name,
    status: ReplayStatus.UNVERIFIABLE,
    steps: [...steps],
    unverifiable: { reason: `step ${String(step.step)}: ${step.drift.reason}` },
  };
}
/**
 * The answer for a step expectation that did not pass and was not decided, or undefined when it was
 * decided. Before this, an inconclusive expectation was reported as a consequence that did not hold.
 */
export function undecidedExpectDrift(
  verdict: { inconclusive?: string; observationLost?: boolean },
  expect: NonNullable<FlowStep['expect']>,
): Drift | undefined {
  // The wait ended because the page stopped being observable, not because the consequence failed:
  // the same fact as a command the dying socket rejected, so it takes the same path (the replay loop
  // reports a lost document). As a drift, a socket that blinked for 26ms read as the app's defect.
  if (true === verdict.observationLost) {
    throw new Error(SESSION_DISCONNECTED_REASON);
  }
  if (verdict.inconclusive === undefined) {
    return undefined;
  }
  return {
    reasonKind: DriftReason.EXPECT_UNDECIDED,
    reason: `the step's consequence was not decided: ${verdict.inconclusive}`,
    anchor: expectLabel(expect),
    nearest: null,
  };
}
