/**
 * What a planned sequence proved, from what its steps DECLARED.
 *
 * A batch that acts without declaring a consequence is the fastest way yet built to prove nothing —
 * it drives a whole journey in one round trip and every step reports `ok`, which reads as success and
 * is not. The engine already refuses this shape for a single action (`no-fault`: "nothing was declared
 * to prove -- this is not verification"); a plan has to refuse it too, or batching becomes a false
 * green with a speed improvement attached.
 *
 * Pure on purpose: the decision is separable from the driving, so it is tested without a browser,
 * exactly as `runVerify` is separable from the connection it runs over.
 *
 * The coverage is never averaged away. A plan of twelve steps where three declared and all three held
 * is verified FOR THOSE THREE and silent about nine, and `because` says so — reporting it as "25%
 * verified" would be the arithmetic that hides the nine.
 */

import { Verified } from '@reticlehq/core';

/**
 * What to do when a step's declared consequence does not hold.
 *
 * `halt` is the default because a dependent chain is the common case: continuing past a broken login
 * produces a run of meaningless failures that bury the one real finding. `continue` is right for a
 * sweep of independent controls, where stopping at the first would hide the other thirteen.
 */
export const DeviationMode = { HALT: 'halt', CONTINUE: 'continue' } as const;
export type DeviationMode = (typeof DeviationMode)[keyof typeof DeviationMode];

/** What one step's declared consequence produced. `declared: false` means the step asserted nothing. */
export interface StepExpectation {
  declared: boolean;
  /** Whether the declared consequence held. Absent when nothing was declared. */
  held?: boolean;
  /** What was seen instead, on a miss — the half of the answer a repair actually needs. */
  observed?: string;
  expected?: string;
}

export interface SequenceGrade {
  verified: Verified;
  /** Steps that declared a consequence. */
  declared: number;
  total: number;
  /** One sentence naming the deciding evidence — a miss first, coverage otherwise. */
  because: string;
}

/**
 * The plan this grade is about, which is not the same as the steps that were reached.
 *
 * `total` used to be `steps.length` — the steps that got far enough to carry an expectation — while
 * the caller's `coverage.total` counted the plan. A two-step sequence refused at step one answered
 * "all 1 step(s) declared nothing" beside `coverage: { total: 2 }`: two numbers for one plan.
 */
interface SequencePlan {
  /** How many steps the caller asked for. */
  readonly planned: number;
  /** Whether anything actually reached the page. */
  readonly dispatched: boolean;
}

export function gradeSequence(
  steps: readonly StepExpectation[],
  plan: SequencePlan = { planned: steps.length, dispatched: true },
): SequenceGrade {
  const total = Math.max(plan.planned, steps.length);
  const declaring = steps.filter((step) => step.declared);
  const declared = declaring.length;
  const missed = declaring.find((step) => true !== step.held);

  // A miss decides the grade before coverage does. How much of the plan declared nothing is
  // context on a red, never a softening of it.
  if (missed !== undefined) {
    const observed = missed.observed ?? 'nothing that matched';
    return {
      verified: Verified.NO,
      declared,
      total,
      because: `a declared consequence did not hold — observed ${observed}`,
    };
  }

  /*
   * `unknown` rather than `no-fault`, and the distinction is load-bearing.
   *
   * "Nothing was declared" is what `no-fault` means for a single action -- but the engine only says
   * it over a SETTLED window, because no-fault claims the whole window was observed. Nothing on
   * this path observes settledness: the caller tracks dispatch and stalls, never settle. Saying
   * `no-fault` here would claim evidence nobody collected, in the one place this product cannot
   * afford to overclaim.
   *
   * So the enum stays conservative and the SENTENCE carries the whole answer: it names declaring a
   * consequence as the next move, which is what an agent reading `no-fault` would have done.
   * Upgrading means plumbing `settled` from the act results through `SequencePlan`.
   */
  if (0 === declared) {
    return {
      verified: Verified.UNKNOWN,
      declared,
      total,
      because:
        0 === total
          ? 'the plan had no steps, so nothing was driven and nothing was proved'
          : // "the app was driven" was said unconditionally, including on a call whose own
            // `dispatched` was false in the same object. A step refused before dispatch is a
            // malformed call, and telling its author to add an `expect` sends them at the wrong
            // thing entirely.
            plan.dispatched
            ? `all ${String(total)} step(s) declared nothing, so the app was driven but not verified — give each step an \`expect\` naming the consequence it causes`
            : `nothing was dispatched, so none of the ${String(total)} step(s) ran — read the per-step \`error\` for the one that was refused, and fix that before adding an \`expect\``,
    };
  }

  return {
    verified: Verified.YES,
    declared,
    total,
    because:
      declared === total
        ? `every declared consequence held (${String(declared)} of ${String(total)} steps)`
        : `every declared consequence held, but only ${String(declared)} of ${String(total)} steps declared one — the rest were driven, not verified`,
  };
}

/**
 * The offer to keep a driven plan as a flow, or nothing.
 *
 * A completed sequence is already a compiled program — anchors resolved, actions ordered, and, where
 * a step declared one, a consequence. It is a flow minus somebody deciding to save it, and the agent
 * holds the whole thing at the moment it is cheapest to keep.
 *
 * The gate is the part that matters: **no consequence, no save.** A plan where every step drove and
 * none declared replays green whatever the app does, so offering to keep it would manufacture
 * regression coverage that cannot go red — the same false green `unverifiable` names on the suite,
 * one step earlier. A plan whose consequence did NOT hold is not offered either: that journey is the
 * bug report, not the regression test, and saving it now would pin the broken behaviour as expected.
 *
 * The coverage travels in the sentence for the same reason it travels on the verdict. Keeping a
 * two-of-twelve plan as a regression flow is a reasonable thing to do and a bad thing to do without
 * knowing it.
 */
export function offerToKeep(grade: SequenceGrade): string | undefined {
  if (grade.verified !== Verified.YES || 0 === grade.declared) return undefined;
  return (
    `this plan proved something (${String(grade.declared)} of ${String(grade.total)} steps declared a ` +
    'consequence and every one held) — keep it as a regression flow with ' +
    'reticle_flow_save { saveAs: "<name>" }, and the steps that declared nothing will replay ' +
    'without proving anything, exactly as they did here'
  );
}
