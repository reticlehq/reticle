/**
 * Testing the test: break the subject on purpose and see whether the flow notices.
 *
 * Everyone tests the application. Nobody tests the test. A flow that would stay green if the feature
 * broke is worse than no flow — it is a false green carrying a maintenance cost, and it is
 * indistinguishable from a real one until the day it matters.
 *
 * Asking for more declared consequences is a request, and requests do not scale. This is the same
 * question asked mechanically: perturb the subject, replay the flow, and grade the FLOW by whether it
 * went red. One that does not is demoted — it is not a test, it is a click sequence.
 *
 * The figure this produces is the one nobody in this space publishes. Not "how many bugs do we
 * catch", which is a claim about the subject, but "what fraction of our own suite would notice if
 * the feature broke", which is a claim about ourselves.
 */

import { z } from 'zod';

/**
 * Ways a subject can be broken on purpose.
 *
 * Open at the edge, like every other vocabulary here: a realm perturbs what it has. Web removes a
 * handler or renames a locator; a service fails a request; a game freezes a subsystem. Hardware
 * almost certainly declares none of them, and that is a correct answer rather than a missing
 * feature — a rig you can break on demand is a rig you can break by accident.
 */
export const MutationKind = {
  /** The control is still there and does nothing. The commonest real regression. */
  HANDLER_REMOVED: 'handler-removed',
  /** The thing a flow anchors to is renamed — does the flow notice, or does it heal into a lie? */
  LOCATOR_RENAMED: 'locator-renamed',
  /** A request the subject depends on fails. The service realm's whole vocabulary in one entry. */
  REQUEST_FAILS: 'request-fails',
  /** The write is accepted and discarded — the optimistic update that never committed. */
  EFFECT_DISCARDED: 'effect-discarded',
} as const;
export type MutationKind = (typeof MutationKind)[keyof typeof MutationKind];

/** How to put the subject back. Returned by `mutate`, because a break nobody can undo is damage. */
export const ReversalSchema = z.object({
  /** The mutation this undoes. Named so a run can never lose track of what it left broken. */
  mutation: z.string().min(1),
});
export type Reversal = z.infer<typeof ReversalSchema>;

/** What one mutation established about one flow. */
export const MutationOutcome = {
  /** The flow went red. It would have caught this, which is the only outcome that proves anything. */
  KILLED: 'killed',
  /** The flow stayed green through a broken subject. It is not testing what it appears to test. */
  SURVIVED: 'survived',
  /** Nothing was established — see `gradeMutation`. Never counted either way. */
  INCONCLUSIVE: 'inconclusive',
} as const;
export type MutationOutcome = (typeof MutationOutcome)[keyof typeof MutationOutcome];

export interface MutationRun {
  /** The flow's verdict on an unbroken subject. */
  before: 'pass' | 'fail';
  /** Its verdict with the mutation applied. */
  after: 'pass' | 'fail';
  /** False when the realm could not perturb the subject. Defaults to applied. */
  applied?: boolean;
}

/**
 * What this run established about the flow — and, as often, that it established nothing.
 *
 * Only a flow that was GREEN and went RED has said anything. The other cases are inconclusive for
 * reasons worth keeping apart from a result:
 *
 *   - a flow already failing was going to fail either way, and counting that as `killed` is how a
 *     mutation score inflates itself into meaninglessness — the broken flows would carry the grade
 *     for the ones that assert nothing;
 *   - a mutation the realm could not apply says nothing about the flow, and scoring it as a survival
 *     would demote flows for a gap in the MUTATION SET rather than in themselves.
 *
 * Pure: one run in, one grade out.
 */
export function gradeMutation(run: MutationRun): MutationOutcome {
  if (false === run.applied) return MutationOutcome.INCONCLUSIVE;
  if ('pass' !== run.before) return MutationOutcome.INCONCLUSIVE;
  return 'fail' === run.after ? MutationOutcome.KILLED : MutationOutcome.SURVIVED;
}
