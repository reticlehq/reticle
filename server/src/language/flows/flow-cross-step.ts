import {
  ContradictionKind,
  type Contradiction,
  type FlowStep,
  type FlowStepResult,
  type Predicate,
} from '@reticlehq/core';
import { flattenSteps } from './flow-classify.js';

/** A contradiction's identity for de-duplication: the rule that fired, and the evidence it fired on. */
function contradictionId(found: Contradiction): string {
  return `${found.kind}|${found.detail}`;
}

/**
 * Kinds that only mean something inside ONE action's window. A duplicate request claims "one user
 * action was performed"; across a whole flow there are many actions, so a toggle hit once per step
 * (Pause, then Resume) read as a double submit (#2013). Each step already checks its own window.
 */
const ONE_ACTION_ONLY: ReadonlySet<string> = new Set([
  ContradictionKind.DUPLICATE_REQUEST,
  ContradictionKind.DUPLICATE_REQUEST_UNRELATED,
]);

/** True for a finding that only means something inside one action's window (see ONE_ACTION_ONLY). */
export function isOneActionOnly(found: { kind: string }): boolean {
  return ONE_ACTION_ONLY.has(found.kind);
}

/**
 * Kinds a step window cannot decide. "Never settled" means never, and a step's window closes while
 * the replay still runs: a request a step's predecessor started late can finish a moment after this
 * window ends. The whole-span pass, run when the replay is over, sees whether it ever came back.
 */
const DECIDED_AT_THE_END: ReadonlySet<string> = new Set([ContradictionKind.REQUEST_NEVER_SETTLED]);

/** A step's own findings, without the ones only the end of the replay can decide. */
export function stepContradictions(found: readonly Contradiction[]): Contradiction[] {
  return found.filter((c) => !DECIDED_AT_THE_END.has(c.kind));
}

/** Cross-step findings belong to no single step; -1 is the address the suite verdict already uses. */
export const CROSS_STEP_INDEX = -1;

/**
 * The contradictions the whole-span pass found that no individual step could.
 *
 * A step's window closes when the step ends, so a request fired at step 2 and still unanswered at
 * step 5 is invisible to every per-step window: step 2's closed before the answer came and step 5
 * never saw it start. Re-running the detectors over the whole replay span finds those — and re-finds
 * everything the steps already reported, which is what the subtraction is for. Reporting a finding
 * twice teaches a reader that the count is noise.
 *
 * Exported for its own test: the subtraction is the whole rule, and it is pure.
 */
export function crossStepOnly(
  whole: readonly Contradiction[],
  steps: readonly FlowStepResult[],
): Contradiction[] {
  const seen = new Set(steps.flatMap((step) => (step.contradictions ?? []).map(contradictionId)));
  return whole.filter((found) => !seen.has(contradictionId(found)) && !isOneActionOnly(found));
}

/**
 * Every consequence the flow declared, sub-steps included. The whole-span pass judges the same
 * window the steps did, so a failure a step expected is expected here too. Without it, the per-step
 * pass dropped the declared failure and this pass reported it again as a cross-step finding.
 */
export function declaredIn(steps: readonly FlowStep[]): Predicate[] {
  return flattenSteps(steps).flatMap((step) => (step.expect === undefined ? [] : [step.expect]));
}
