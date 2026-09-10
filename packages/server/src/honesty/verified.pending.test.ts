/**
 * A write the server has ACCEPTED but not finished is not a failed assertion.
 *
 * `202 Accepted` is the only word HTTP has for "the outcome does not exist yet". The rule already
 * knew that and already returned UNKNOWN for it, with the right reasoning written beside the clause:
 * *nothing has failed, and saying it has would be its own false report.*
 *
 * It just never got the chance. The pending clause sat BELOW the failed-assertion clause, so the
 * moment the predicate came back false — which is exactly what a not-yet-reconciled write looks like
 * — `assertion_failed` answered first and the pending clause was unreachable. The verdict blamed the
 * app for being asynchronous.
 *
 * `observationLost` already sits above the failure clause for the identical reason, and says so:
 * a wait that ended when the tab vanished did not fail, it was never finished. This is the same
 * shape. Absent evidence is not negative evidence, in either direction.
 *
 * It matters more for a non-UI realm than for a page. An HTTP realm's normal, healthy case is a
 * write that is accepted and reflected a moment later, so `no` there is a false negative in the
 * common path rather than an edge case.
 *
 * This file pins BOTH directions, because a fix that removes a false red is the change most capable
 * of silently un-detecting a real bug:
 *
 *   - accepted-but-unfinished  -> UNKNOWN, and the caller is told to re-check
 *   - an ordinary failure      -> NO, exactly as before
 */

import { describe, expect, it } from 'vitest';
import { Verified, VerifiedReason } from '@reticlehq/core';
import { decideVerified } from './verified.js';
import { HonestyGrade } from './honesty.js';

/** A clean, settled capture at signal grade — so nothing else in the rule can be what decided it. */
const clean = {
  grade: HonestyGrade.SIGNAL,
  attribution: 'window',
  coverage: { pct: 100, partial: false },
  integrity: { clean: true, issues: [] },
  settled: true,
};

describe('an accepted-but-unfinished write is not a failure', () => {
  it('a failed predicate with a write still being processed is UNKNOWN, not NO', () => {
    const out = decideVerified({
      pass: false,
      declaredConsequence: true,
      honesty: clean,
      settled: true,
      outcomePending: true,
    });
    expect(out.verified).toBe(Verified.UNKNOWN);
    expect(out.verifiedReason).toBe(VerifiedReason.OUTCOME_PENDING);
    // The caller has to be told this is worth re-checking, or UNKNOWN reads as a dead end.
    expect(out.because).toMatch(/re-check|reconcile/i);
  });

  it('a passing predicate with a write still being processed is also UNKNOWN', () => {
    // Unchanged behaviour, pinned so the reorder cannot quietly alter the case it already covered.
    const out = decideVerified({
      pass: true,
      declaredConsequence: true,
      honesty: clean,
      settled: true,
      outcomePending: true,
    });
    expect(out.verified).toBe(Verified.UNKNOWN);
    expect(out.verifiedReason).toBe(VerifiedReason.OUTCOME_PENDING);
  });

  it('THE OTHER DIRECTION: an ordinary failed assertion is still NO', () => {
    const out = decideVerified({
      pass: false,
      declaredConsequence: true,
      honesty: clean,
      settled: true,
    });
    expect(out.verified).toBe(Verified.NO);
    expect(out.verifiedReason).toBe(VerifiedReason.ASSERTION_FAILED);
  });

  it('THE OTHER DIRECTION: a lost observation still outranks a pending write', () => {
    // observationLost is above both. A disconnected observer explains the missing outcome better
    // than "the server is still working", and its remedy is the one the caller can act on.
    const out = decideVerified({
      pass: false,
      declaredConsequence: true,
      honesty: clean,
      settled: true,
      outcomePending: true,
      observationLost: true,
    });
    expect(out.verifiedReason).toBe(VerifiedReason.OBSERVATION_LOST);
  });

  it('an unclean capture AND a pending write is UNKNOWN, and says the write is pending', () => {
    // Pinned because the reorder changed this combination, and the change is in the right
    // direction: it used to answer `no | assertion_failed`. `unclean_capture` was never what it
    // said, because that clause also sits below the failure clause and never ran for a failing
    // predicate either.
    //
    // Both clauses mean UNKNOWN, so the verdict is the same and only the sentence differs. Whether
    // "our capture was incomplete" is the more useful remedy than "the server has not finished" when
    // both are true is a real question, and deliberately not answered here: it is a second change,
    // and this one is scoped to the pending write.
    const out = decideVerified({
      pass: false,
      declaredConsequence: true,
      honesty: { ...clean, integrity: { clean: false, issues: ['capture truncated'] } },
      settled: true,
      outcomePending: true,
    });
    expect(out.verified).toBe(Verified.UNKNOWN);
    expect(out.verifiedReason).toBe(VerifiedReason.OUTCOME_PENDING);
  });
});
