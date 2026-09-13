/**
 * Replay, break the thing the flow watches, replay again, and grade the FLOW.
 *
 * This is the loop that turns *"most recorded steps would not notice if the feature broke"* from a
 * complaint into a number the engine assigns itself. Everything it needs already exists — a realm
 * that can perturb a driven page, a replay that produces a verdict, and the pure grade. What this
 * adds is the property that makes running it safe at all.
 *
 * **The reversal is the design, not a tidy-up.** A mutation is a real break on a real page. If a
 * replay throws mid-flight and the break is left behind, the next flow inherits a subject that is
 * not the subject: every verdict after it is about an app answering 500 to something no developer
 * broke, and the run reports a cascade of failures with no cause anybody can find. The undo
 * therefore runs on every path out of here, including the ones nobody planned.
 *
 * Pure orchestration: the three capabilities are injected, so this is tested without a browser, a
 * realm or a flow file — and so it cannot quietly acquire a dependency on any of them.
 */

import { gradeMutation, MutationOutcome, type Reversal } from '@reticlehq/openreality';

export interface MutationTestDeps {
  /** Replay the flow and report its verdict. */
  replay(): Promise<'pass' | 'fail'>;
  /** Break the subject. Rejecting is a refusal, and a refusal is not a result. */
  mutate(mutation: { kind: string; target?: string }): Promise<Reversal>;
  /** Put it back. */
  revert(): Promise<void>;
}

export async function mutationTest(
  deps: MutationTestDeps,
  mutation: { kind: string; target?: string },
): Promise<MutationOutcome> {
  let before: 'pass' | 'fail';
  try {
    before = await deps.replay();
  } catch {
    return MutationOutcome.INCONCLUSIVE;
  }
  /*
   * A flow that was already failing is inconclusive whatever happens next, so the page is never
   * broken for it. That is not only a saving: every mutation carries the risk of not being undone,
   * and the cheapest way to never leave a break behind is not to make one.
   */
  if ('pass' !== before) return MutationOutcome.INCONCLUSIVE;

  try {
    await deps.mutate(mutation);
  } catch {
    // The realm refused. Nothing was applied, so there is nothing to revert — and reverting anyway
    // would clear rules somebody else installed.
    return MutationOutcome.INCONCLUSIVE;
  }

  try {
    const after = await deps.replay();
    return gradeMutation({ before, after });
  } catch {
    /*
     * A replay that threw did not stay green — it said nothing. Grading it SURVIVED would demote a
     * flow for an error in the harness, which is the mutation score blaming the suite for its own
     * failure.
     */
    return MutationOutcome.INCONCLUSIVE;
  } finally {
    // Every path, including the ones above that return early from the try. A revert that itself
    // fails cannot be fixed from here, and throwing would replace a usable grade with an exception:
    // the page belongs to the caller, and so does that failure.
    await deps.revert().catch(() => undefined);
  }
}
