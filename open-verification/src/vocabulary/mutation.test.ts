import { describe, expect, it } from 'vitest';
import { MutationOutcome, gradeMutation, MutationKind, ReversalSchema } from './mutation.js';

/**
 * Everyone tests the app. Nobody tests the test.
 *
 * A flow that would stay green if the feature broke is worse than no flow: it is a false green with
 * a maintenance cost, and it is indistinguishable from a real one until the day it matters. Asking
 * agents to declare more consequences has measurably not worked, so the engine grades itself
 * instead — break the subject on purpose, replay the flow, and see whether the flow notices.
 *
 * A flow that does not go RED against a deliberately broken subject is demoted. It is not a test, it
 * is a click sequence.
 *
 * The number this produces is the one nobody in this space publishes: not "how many bugs do we
 * catch" but "what fraction of our own suite would notice if the feature broke".
 */

describe('what a flow surviving a mutation means', () => {
  it('KILLS the mutation when a green flow goes red', () => {
    // The only outcome that proves anything about the flow.
    expect(gradeMutation({ before: 'pass', after: 'fail' })).toBe(MutationOutcome.KILLED);
  });

  it('SURVIVES when the flow stays green through a broken subject', () => {
    expect(gradeMutation({ before: 'pass', after: 'pass' })).toBe(MutationOutcome.SURVIVED);
  });

  it('is INCONCLUSIVE when the flow was already failing', () => {
    // Running a mutation against an already-red flow proves nothing: it was going to be red either
    // way. Counting that as KILLED is how a mutation score inflates itself into meaninglessness —
    // the broken flows would carry the grade for the ones that never assert anything.
    expect(gradeMutation({ before: 'fail', after: 'fail' })).toBe(MutationOutcome.INCONCLUSIVE);
  });

  it('is INCONCLUSIVE when a red flow went green, however unlikely', () => {
    // Nothing about the flow is established by that, and it is a fact about the RUN worth keeping
    // rather than a result worth scoring.
    expect(gradeMutation({ before: 'fail', after: 'pass' })).toBe(MutationOutcome.INCONCLUSIVE);
  });

  it('is INCONCLUSIVE when the mutation could not be applied at all', () => {
    // A realm that declined the perturbation has told us nothing about the flow, and scoring it as
    // a survival would demote flows for a gap in the MUTATION SET rather than in themselves.
    expect(gradeMutation({ before: 'pass', after: 'pass', applied: false })).toBe(
      MutationOutcome.INCONCLUSIVE,
    );
  });
});

describe('the undo a realm hands back', () => {
  it('must name the mutation it reverses, so nothing can be left broken by accident', () => {
    expect(() => ReversalSchema.parse({ mutation: 'break-testid-1' })).not.toThrow();
    expect(() => ReversalSchema.parse({})).toThrow();
  });

  it('names the kinds a subject can be broken in', () => {
    // Web breaks a locator or kills a handler; a service returns 500. Hardware almost certainly
    // declares none of them, and that is a correct answer rather than a missing feature.
    expect(Object.values(MutationKind)).toContain('handler-removed');
    expect(Object.values(MutationKind)).toContain('request-fails');
  });
});
