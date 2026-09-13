/**
 * Whether a replay stopped before the end of the flow, and how much it never reached.
 *
 * `replayFlow` breaks on the first failing step. That is right — once a consequence did not hold,
 * every later step would run against a state the flow never described, and continuing would turn
 * one wrong result into several. What was missing is any way for the caller to SEE it: a two-step
 * flow that halted comes back with one step result, and a reader who does not know the halt rule
 * sees a step that is simply absent.
 *
 * Reported as "replay silently skips a second destructive step" — with three correct observations
 * and a wrong conclusion, because the output offered no other reading.
 */

import type { FlowStepResult } from '@reticlehq/core';

/** Set on a replay that stopped early; omitted entirely otherwise, so a clean pass stays flat. */
export interface ReplayHalt {
  /** Index of the step that stopped the run. */
  atStep: number;
  /** How many of the flow's steps were never attempted because of it. */
  notAttempted: number;
}

/**
 * `total` is the FLOW's step count, deliberately — not `results.length`. The results array is the
 * short one, so deriving the total from it would report zero skipped on every halt, which is the
 * defect restated as its own fix.
 */
export function haltedFrom(
  results: readonly FlowStepResult[],
  total: number,
): ReplayHalt | undefined {
  const last = results[results.length - 1];
  if (last === undefined) return undefined;
  if (last.ok && last.drift === undefined) return undefined;
  const notAttempted = total - results.length;
  // A failure on the FINAL step is not a halt: nothing was left to attempt, and `notAttempted: 0`
  // would send a reader looking for steps that do not exist.
  if (notAttempted <= 0) return undefined;
  return { atStep: last.step, notAttempted };
}
