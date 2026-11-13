/**
 * Classify whether a flow asserts an observable CONSEQUENCE or is "assertion-free" / presence-only.
 *
 * Why this exists (grounded in real testing behavior):
 * - Martin Fowler, *Assertion-Free Testing*: teams hit 100% coverage with tests that "weren't any
 * assertions" — green, but verifying nothing.
 * - Kent C. Dodds, *Make Your Test Fail*: a test that doesn't fail when you break the code gives
 * false security.
 * - Self-healing vendors (mabl, qate.ai) admit a locator healed to the WRONG element makes a test
 * pass green while a real regression ships — but only if the test merely checks presence.
 * - AI agents agree with human pass/fail only ~68% of the time (arXiv 2510.02418), so the flow
 * itself must carry a real oracle, not rely on the agent eyeballing success.
 *
 * For a flow, an FlowExpect can assert a `signal` (app emitted an event), a `net` call, or just an
 * `element` presence. signal/net are OBSERVABLE CONSEQUENCES — they can't be satisfied by a wrong
 * element. element-only is WEAK — a healed-but-wrong locator can still satisfy it. A flow with no
 * expect on any step and no success end-condition asserts nothing at all.
 *
 * Pure: no IO, no clock.
 */

import { PredicateKind, flowExpectHasConsequence, flowExpectIsPresenceOnly } from '@reticlehq/core';
import type { FlowFile, FlowStep, Predicate } from '@reticlehq/core';
import { z } from 'zod';

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
  /** The flow's declared business goal, if any (the intent annotation). */
  intent?: string;
  /**
   * True only when the flow BOTH declares a business intent AND asserts an observable business
   * OUTCOME (a consequence — signal/net). This is the "intent + outcome oracle": a flow earns
   * `intentVerified` when it can actually fail if its declared goal stops being met. A flow with an
   * intent but only presence-only checks is the dangerous case — it claims a goal it cannot verify.
   */
  intentVerified: boolean;
  /**
   * How many checks of each predicate kind the flow runs, over every step, sub-step and the success
   * state, composites flattened. Absent when the flow checks nothing. A presence-only grade with
   * this list says WHAT is checked, so the grade does not read as "checks nothing" (#1840).
   */
  checks?: Record<string, number>;
  /** Present for presence-only / assertion-free flows: how to make the flow a real test. */
  warning?: string;
}

/**
 * The `assertions` block of the `reticle_flow_save` result. Declared here, next to the type it
 * describes, because a validating profile removes a field that the output schema does not declare.
 */
export const FLOW_ASSERTIONS_OUTPUT = z
  .object({
    grade: z.string().describe('asserted | presence-only | assertion-free'),
    hasConsequenceAssertion: z.boolean(),
    totalSteps: z.number(),
    consequenceSteps: z.number(),
    weakSteps: z.number(),
    checks: z
      .record(z.string(), z.number())
      .optional()
      .describe(
        'Checks of each predicate kind (text, element, route, net, signal, …) the flow runs.',
      ),
    warning: z.string().optional(),
  })
  .optional();

const ASSERTION_FREE_WARNING =
  'This flow performs actions but asserts no observable consequence, so it will pass even if the feature is broken. Add a consequence assertion with reticle_annotate (assert-signal / assert-net) or a success-state.';
/** Why a presence check is weaker than a consequence, and the fix. Shared by both presence notes. */
const PRESENCE_ONLY_ADVICE =
  'A locator healed to the wrong element can still pass it. Add a consequence assertion (assert-signal / assert-net / success-state).';
const PRESENCE_ONLY_WARNING = `This flow only checks element presence, not an observable consequence (signal/network). ${PRESENCE_ONLY_ADVICE}`;
/** The presence note when the checks are known: it names them, then says why they are weak. */
const presenceOnlyWarning = (checks: string): string =>
  `This flow checks ${checks} on the page. These are presence checks, not an observable consequence (signal/network). ${PRESENCE_ONLY_ADVICE}`;
const INTENT_WITHOUT_OUTCOME_WARNING =
  'This flow declares a business intent but asserts no observable outcome (signal/network) — it claims to verify a goal it cannot actually check. Add a success-state consequence so the flow fails when the goal stops being met.';

// Consequence vs presence-only classification lives in @reticlehq/core (one source for all graders).
const expectIsConsequence = flowExpectHasConsequence;
const expectIsWeak = flowExpectIsPresenceOnly;

/**
 * A step expect counts the same as a flow-level one, because replay now evaluates the same set.
 *
 * This was briefly narrowed to `state` only — correctly, at the time: replay checked element presence
 * and state and nothing else, so grading a step signal/net as a consequence produced a flow that
 * reported `grade: "asserted"` and could not go red. `assertStepExpect` closed that by compiling
 * every step expect through the same `successToPredicate` the flow-level path uses, so the narrow
 * rule is no longer true and would now UNDER-grade real assertions.
 *
 * The invariant to keep: this function and what replay enforces must move together. If one ever
 * describes more than the other, the difference is a false green or a lost verification.
 */
/** Walk steps + act_sequence sub-steps so an expect on either level is counted. */
export function flattenSteps(steps: readonly FlowStep[]): FlowStep[] {
  const out: FlowStep[] = [];
  for (const s of steps) {
    out.push(s);
    if (s.steps !== undefined) {
      out.push(...flattenSteps(s.steps));
    }
  }
  return out;
}

/**
 * Does this flow, or anything it invokes, assert a consequence?
 *
 * A composite is as asserted as what it runs. Driving one showed why this is not optional: a
 * journey invoking a sub-flow that asserts a signal still graded `assertion-free`, warning that it
 * "claims to verify a goal it cannot actually check". That was correct about the FILE — the invoke
 * step carries no `expect` — and wrong about the JOURNEY, which asserts exactly once, in the
 * document that owns the steps. Left alone it pushes people to duplicate the sub-flow's assertion
 * into every caller, which is the copy-paste composition exists to remove.
 *
 * A sub-flow that cannot be READ is not credited. Same direction as every other "cannot tell" here:
 * crediting an assertion nobody has looked at grades a composite on a promise.
 *
 * `seen` makes a cycle terminate. Typecheck refuses those at rest and this must not depend on that
 * having run — grading is reached from save, which is exactly where a bad composite arrives first.
 */
function invokedAssertsConsequence(
  flow: FlowFile,
  invoked: ReadonlyMap<string, FlowFile>,
  seen: ReadonlySet<string>,
): boolean {
  if (seen.has(flow.name)) {
    return false;
  }
  const deeper = new Set([...seen, flow.name]);
  for (const step of flattenSteps(flow.steps)) {
    if (step.invoke === undefined) {
      continue;
    }
    const sub = invoked.get(step.invoke);
    if (sub === undefined) {
      continue;
    }
    const subSteps = flattenSteps(sub.steps);
    if (subSteps.some((s) => expectIsConsequence(s.expect)) || expectIsConsequence(sub.success)) {
      return true;
    }
    if (invokedAssertsConsequence(sub, invoked, deeper)) {
      return true;
    }
  }
  return false;
}

/** Every leaf clause of an expectation, composites flattened. */
function leafClauses(expect: Predicate | undefined): Predicate[] {
  if (expect === undefined) {
    return [];
  }
  if (PredicateKind.ALL_OF === expect.kind || PredicateKind.ANY_OF === expect.kind) {
    return expect.predicates.flatMap(leafClauses);
  }
  if (PredicateKind.NOT === expect.kind) {
    return leafClauses(expect.predicate);
  }
  return [expect];
}

/** Checks of each kind over the given expectations, keys in name order, or undefined for none. */
function countChecks(
  expects: readonly (Predicate | undefined)[],
): Record<string, number> | undefined {
  const counts = new Map<string, number>();
  for (const clause of expects.flatMap(leafClauses)) {
    counts.set(clause.kind, (counts.get(clause.kind) ?? 0) + 1);
  }
  if (0 === counts.size) {
    return undefined;
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** "text (3), element (1) and route (1)": most checks first, ties in name order. */
function describeChecks(checks: Record<string, number>): string {
  const parts = Object.entries(checks)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([kind, n]) => `${kind} (${String(n)})`);
  const last = parts.pop() ?? '';
  return 0 === parts.length ? last : `${parts.join(', ')} and ${last}`;
}

function responseIsDeclared(step: FlowStep): boolean {
  const r = step.response;
  return (
    r !== undefined &&
    (r.status !== undefined || r.contains !== undefined || r.absent !== undefined)
  );
}

export function classifyFlowAssertions(
  flow: FlowFile,
  /**
   * The flows this one invokes, already loaded.
   *
   * A map rather than a loader so this stays pure and synchronous: the caller has the store and the
   * async, and a classifier that could do IO would be a classifier that could fail for reasons that
   * have nothing to do with the flow it is grading.
   */
  invoked: ReadonlyMap<string, FlowFile> = new Map(),
): FlowAssertionClassification {
  const all = flattenSteps(flow.steps);
  let consequenceSteps = 0;
  let weakSteps = 0;
  for (const s of all) {
    // A request step's declared response judges what the server answered: a consequence.
    if (expectIsConsequence(s.expect) || responseIsDeclared(s)) {
      consequenceSteps++;
    } else if (expectIsWeak(s.expect)) {
      weakSteps++;
    }
  }
  const invokedAsserts = invokedAssertsConsequence(flow, invoked, new Set());
  const successIsConsequence = expectIsConsequence(flow.success);
  const successIsWeak = expectIsWeak(flow.success);
  const hasConsequenceAssertion = consequenceSteps > 0 || successIsConsequence || invokedAsserts;
  const hasAnyAssertion = hasConsequenceAssertion || weakSteps > 0 || successIsWeak;

  const checks = countChecks([...all.map((s) => s.expect), flow.success]);
  const intent = flow.intent;
  const intentVerified = intent !== undefined && hasConsequenceAssertion;

  let grade: FlowAssertionGrade;
  let warning: string | undefined;
  if (hasConsequenceAssertion) {
    grade = FlowAssertionGrade.ASSERTED;
  } else if (hasAnyAssertion) {
    grade = FlowAssertionGrade.PRESENCE_ONLY;
    // What it checks first, so the grade does not read as "checks nothing" (#1840).
    warning =
      checks === undefined ? PRESENCE_ONLY_WARNING : presenceOnlyWarning(describeChecks(checks));
  } else {
    grade = FlowAssertionGrade.ASSERTION_FREE;
    warning = ASSERTION_FREE_WARNING;
  }
  // A declared-but-unverifiable business goal is the sharper failure: surface it over the generic
  // assertion warning, since the flow actively claims to check something it cannot.
  if (intent !== undefined && !hasConsequenceAssertion) {
    warning = INTENT_WITHOUT_OUTCOME_WARNING;
  }

  return {
    grade,
    hasConsequenceAssertion,
    totalSteps: all.length,
    consequenceSteps,
    weakSteps,
    successIsConsequence,
    ...(checks === undefined ? {} : { checks }),
    ...(intent !== undefined ? { intent } : {}),
    intentVerified,
    ...(warning !== undefined ? { warning } : {}),
  };
}
