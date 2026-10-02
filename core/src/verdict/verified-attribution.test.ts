/**
 * Every `unknown` says WHOSE problem it is (M2).
 *
 * 32% of verdicts are `unknown`, and the field reports keep making the same point about them: the
 * word is honest but unactionable. "The backend answered 202 and has not finished", "the page SDK
 * and the daemon are on different contracts" and "the capture was truncated" are three different
 * people's problems and one word, so an agent reading it cannot tell whether to wait, to fix
 * Reticle's setup, or to look again with better coverage.
 *
 * `verifiedReason` already names the deciding clause. What it does not say is which of four owners
 * that clause belongs to, and that is derivable from what is already held - no new evidence, no new
 * decision, one total map over a closed enum.
 *
 * The map is exhaustive by equality for the same reason the `.reticle` partition is: a new reason
 * must not be able to ship without somebody saying whose problem it is. That is a thirty-second
 * decision at the moment the clause is written, and archaeology a year later.
 */
import { describe, expect, it } from 'vitest';
import { VerifiedReason } from './verified-constants.js';
import { VerdictAttribution, verdictAttributionOf } from './verdict-attribution.js';

describe('the owner of an unverified verdict', () => {
  it('classifies every reason the ladder can produce', () => {
    const unclassified = Object.values(VerifiedReason).filter(
      (reason) => verdictAttributionOf(reason) === undefined,
    );
    expect(
      unclassified,
      'a verdict reason with no owner. Decide which: the app (code), something outside it ' +
        '(environment), Reticle or how it was driven (harness), or missing evidence (could-not-see).',
    ).toEqual([]);
  });

  it('blames the app only when the app was actually disproved', () => {
    expect(verdictAttributionOf(VerifiedReason.ASSERTION_FAILED)).toBe(VerdictAttribution.CODE);
    expect(verdictAttributionOf(VerifiedReason.CONTRADICTED)).toBe(VerdictAttribution.CODE);
  });

  /* Reticle's own pieces disagreeing is Reticle's problem, and saying so is the point of M2. */
  it('owns its own failures rather than reporting them as the app', () => {
    expect(verdictAttributionOf(VerifiedReason.VERSION_SKEW)).toBe(VerdictAttribution.HARNESS);
    expect(verdictAttributionOf(VerifiedReason.WINDOW_CLOSED_EARLY)).toBe(
      VerdictAttribution.HARNESS,
    );
  });

  /* A claim nobody declared, or one that proved nothing, is the caller's - still not the app's. */
  it('puts a weak or absent declaration on the caller, not the app', () => {
    expect(verdictAttributionOf(VerifiedReason.NOTHING_DECLARED)).toBe(VerdictAttribution.HARNESS);
    expect(verdictAttributionOf(VerifiedReason.VACUOUS_GRADE)).toBe(VerdictAttribution.HARNESS);
    expect(verdictAttributionOf(VerifiedReason.ALREADY_TRUE)).toBe(VerdictAttribution.HARNESS);
  });

  it('separates "I could not see" from every other kind of not-knowing', () => {
    for (const reason of [
      VerifiedReason.CAPABILITY_ABSENT,
      VerifiedReason.OBSERVATION_LOST,
      VerifiedReason.UNCLEAN_CAPTURE,
      VerifiedReason.EVIDENCE_INCOMPLETE,
      VerifiedReason.ABSENCE_BLIND_SPOT,
    ]) {
      expect(verdictAttributionOf(reason), reason).toBe(VerdictAttribution.COULD_NOT_SEE);
    }
  });

  /* Still working is not the same as broken, and it is the one class that resolves by waiting. */
  it('calls unfinished work an environment answer, not a defect', () => {
    expect(verdictAttributionOf(VerifiedReason.OUTCOME_PENDING)).toBe(
      VerdictAttribution.ENVIRONMENT,
    );
    expect(verdictAttributionOf(VerifiedReason.UNSETTLED)).toBe(VerdictAttribution.ENVIRONMENT);
  });

  /* A proof has no owner to name. The field is omitted rather than carrying a fifth empty word. */
  it('attributes nothing when the claim was proved', () => {
    expect(verdictAttributionOf(VerifiedReason.PROVED)).toBe(VerdictAttribution.NONE);
  });
});
