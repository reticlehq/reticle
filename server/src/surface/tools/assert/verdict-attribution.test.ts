/**
 * An `unknown` verdict says whose problem it is (M2).
 *
 * 32% of verdicts are `unknown`. The word is honest and unactionable: "the backend answered 202 and
 * has not finished", "the page SDK and the daemon are on different contracts" and "the capture was
 * truncated" arrive as one string, and they need three opposite next moves - wait, fix Reticle's
 * setup, look again with better coverage.
 *
 * The evidence block already keeps `reason`, with the note beside it saying exactly this: "`unknown`
 * alone cannot distinguish an outcome that has not arrived from a capture that could not be read,
 * and only the first is worth asking about again". `attribution` is that sentence finished - a
 * closed four-value enum an agent can branch on, derived from the reason nobody has to re-decide.
 *
 * Derived at the CONSUMER rather than inside the verdict. `core-coupling-only-shrinks` caps how much
 * of core the engine may borrow and says raising it is the thing to argue about in a review; the
 * attribution is a pure function of a reason the engine already returns, so deriving it where the
 * verdict is emitted costs the engine nothing and says the same thing.
 */
import { describe, expect, it } from 'vitest';
import { VerdictAttribution, verdictAttributionOf, VerifiedReason } from '@reticlehq/core';

describe('the attribution carried beside a verdict reason', () => {
  it('tells an agent to WAIT rather than to go looking', () => {
    expect(verdictAttributionOf(VerifiedReason.OUTCOME_PENDING)).toBe(
      VerdictAttribution.ENVIRONMENT,
    );
  });

  it('tells an agent to fix Reticle rather than the app', () => {
    expect(verdictAttributionOf(VerifiedReason.VERSION_SKEW)).toBe(VerdictAttribution.HARNESS);
  });

  it('tells an agent to look again rather than to fix anything', () => {
    expect(verdictAttributionOf(VerifiedReason.UNCLEAN_CAPTURE)).toBe(
      VerdictAttribution.COULD_NOT_SEE,
    );
  });

  /*
   * The three that used to be one word. If any two of these ever collapse again, the field has
   * stopped doing the only job it has.
   */
  it('keeps the three that used to be indistinguishable apart', () => {
    const owners = new Set(
      [
        VerifiedReason.OUTCOME_PENDING,
        VerifiedReason.VERSION_SKEW,
        VerifiedReason.UNCLEAN_CAPTURE,
      ].map((r) => verdictAttributionOf(r)),
    );
    expect(owners.size).toBe(3);
  });

  it('blames the app only where the app was disproved', () => {
    expect(verdictAttributionOf(VerifiedReason.ASSERTION_FAILED)).toBe(VerdictAttribution.CODE);
    expect(verdictAttributionOf(VerifiedReason.CAPABILITY_ABSENT)).not.toBe(
      VerdictAttribution.CODE,
    );
    expect(verdictAttributionOf(VerifiedReason.VERSION_SKEW)).not.toBe(VerdictAttribution.CODE);
  });
});
