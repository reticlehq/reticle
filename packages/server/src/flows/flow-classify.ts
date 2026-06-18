/**
 * Classify whether a flow asserts an observable CONSEQUENCE or is "assertion-free" / presence-only.
 *
 * Why this exists (grounded in real testing behavior):
 *  - Martin Fowler, *Assertion-Free Testing*: teams hit 100% coverage with tests that "weren't any
 *    assertions" — green, but verifying nothing.
 *  - Kent C. Dodds, *Make Your Test Fail*: a test that doesn't fail when you break the code gives
 *    false security.
 *  - Self-healing vendors (mabl, qate.ai) admit a locator healed to the WRONG element makes a test
 *    pass green while a real regression ships — but only if the test merely checks presence.
 *  - AI agents agree with human pass/fail only ~68% of the time (arXiv 2510.02418), so the flow
 *    itself must carry a real oracle, not rely on the agent eyeballing success.
 *
 * For a flow, an FlowExpect can assert a `signal` (app emitted an event), a `net` call, or just an
 * `element` presence. signal/net are OBSERVABLE CONSEQUENCES — they can't be satisfied by a wrong
 * element. element-only is WEAK — a healed-but-wrong locator can still satisfy it. A flow with no
 * expect on any step and no success end-condition asserts nothing at all.
 *
 * Pure: no IO, no clock.
 */

import type { FlowExpect, FlowFile, FlowStep } from '@syrin/iris-protocol';

export const FlowAssertionGrade = {
  /** At least one step (or the success end-condition) asserts a signal/network consequence. */
  ASSERTED: 'asserted',
  /** Only element-presence checks — a healed-but-wrong locator could still pass. */
  PRESENCE_ONLY: 'presence-only',
  /** Performs actions but asserts nothing observable — passes even if the feature is broken. */
  ASSERTION_FREE: 'assertion-free',
} as const;
export type FlowAssertionGrade = (typeof FlowAssertionGrade)[keyof typeof FlowAssertionGrade];

export interface FlowAssertionClassification {
  grade: FlowAssertionGrade;
  /** True when at least one signal/net assertion exists (step-level or success). */
  hasConsequenceAssertion: boolean;
  totalSteps: number;
  consequenceSteps: number;
  weakSteps: number;
  successIsConsequence: boolean;
  /** Present for presence-only / assertion-free flows: how to make the flow a real test. */
  warning?: string;
}

const ASSERTION_FREE_WARNING =
  'This flow performs actions but asserts no observable consequence — it will pass even if the feature is broken. Add a consequence assertion with iris_annotate (assert-signal / assert-net) or a success-state.';
const PRESENCE_ONLY_WARNING =
  'This flow only checks element presence, not an observable consequence (signal/network). A locator healed to the wrong element can still pass it. Add a consequence assertion (assert-signal / assert-net / success-state).';

/** signal or net present → the expect verifies a consequence a wrong element cannot fake. */
function expectIsConsequence(e: FlowExpect | undefined): boolean {
  return e !== undefined && (e.signal !== undefined || e.net !== undefined);
}

/** element-only (no signal/net) → presence check, weak. */
function expectIsWeak(e: FlowExpect | undefined): boolean {
  return (
    e !== undefined && e.element !== undefined && e.signal === undefined && e.net === undefined
  );
}

/** Walk steps + act_sequence sub-steps so an expect on either level is counted. */
function flattenSteps(steps: readonly FlowStep[]): FlowStep[] {
  const out: FlowStep[] = [];
  for (const s of steps) {
    out.push(s);
    if (s.steps !== undefined) out.push(...flattenSteps(s.steps));
  }
  return out;
}

export function classifyFlowAssertions(flow: FlowFile): FlowAssertionClassification {
  const all = flattenSteps(flow.steps);
  let consequenceSteps = 0;
  let weakSteps = 0;
  for (const s of all) {
    if (expectIsConsequence(s.expect)) consequenceSteps++;
    else if (expectIsWeak(s.expect)) weakSteps++;
  }
  const successIsConsequence = expectIsConsequence(flow.success);
  const successIsWeak = expectIsWeak(flow.success);
  const hasConsequenceAssertion = consequenceSteps > 0 || successIsConsequence;
  const hasAnyAssertion = hasConsequenceAssertion || weakSteps > 0 || successIsWeak;

  let grade: FlowAssertionGrade;
  let warning: string | undefined;
  if (hasConsequenceAssertion) {
    grade = FlowAssertionGrade.ASSERTED;
  } else if (hasAnyAssertion) {
    grade = FlowAssertionGrade.PRESENCE_ONLY;
    warning = PRESENCE_ONLY_WARNING;
  } else {
    grade = FlowAssertionGrade.ASSERTION_FREE;
    warning = ASSERTION_FREE_WARNING;
  }

  return {
    grade,
    hasConsequenceAssertion,
    totalSteps: all.length,
    consequenceSteps,
    weakSteps,
    successIsConsequence,
    ...(warning !== undefined ? { warning } : {}),
  };
}
