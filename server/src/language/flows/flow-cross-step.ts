import type { Contradiction, FlowStepResult } from '@reticlehq/core';

/** A contradiction's identity for de-duplication: the rule that fired, and the evidence it fired on. */
function contradictionId(found: Contradiction): string {
  return `${found.kind}|${found.detail}`;
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
  return whole.filter((found) => !seen.has(contradictionId(found)));
}
