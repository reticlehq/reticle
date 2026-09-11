/**
 * Reticle may say an action FAILED only about something it observed.
 *
 * The contradiction clause outranks a passing assertion, and that inversion is the product: a green
 * assertion sitting on top of a failed write is the exact bug class Reticle exists to catch. But it
 * applied to all twelve kinds, including the ones inferred from the ABSENCE of evidence in a window
 * whose end Reticle itself chose — and that window closes the moment the predicate first passes.
 *
 * Reproduced on the bench app before this split: `auth:granted` fired WITH matching data, state
 * changed from null to the authenticated user, the token was written to storage, capture integrity
 * was clean, and the honesty grade was `signal` — the strongest evidence class we have. The verdict
 * was `no`, because one POST had not settled while the app navigated optimistically. A timing
 * observation overruled a consequence observation, inverting the grade hierarchy the verifier is
 * built on. In field data `contradicted` is half of every `no` verdict.
 *
 * A false negative is not the mirror of a false positive here. It makes an agent redo work that
 * already succeeded, or stop trusting the verdict channel — and the verdict channel is the product.
 *
 * So this file pins BOTH directions, because fixing the false red is the change most capable of
 * silently un-detecting a real bug:
 *
 *   - absence-derived alone  -> UNKNOWN, and the finding is still reported
 *   - anything observed      -> NO, exactly as before
 *   - both present           -> NO wins
 */

import { describe, expect, it } from 'vitest';
import { ContradictionKind, Verified, VerifiedReason } from '@reticlehq/core';
import { decideVerified } from './verified.js';
import { HonestyGrade } from './honesty.js';

/** The shape `decideVerified` reads: a passing assertion at signal grade over a clean capture. */
function verdict(kinds: string[]) {
  return decideVerified({
    pass: true,
    contradictions: kinds.map((kind) => ({ kind, claim: 'c', counter: 'x' })),
    honesty: {
      grade: HonestyGrade.SIGNAL,
      attribution: 'window',
      coverage: { pct: 100, partial: false },
      integrity: { clean: true, issues: [] },
    },
  });
}

describe('absence-derived contradictions do not assert failure', () => {
  for (const kind of [
    ContradictionKind.REQUEST_NEVER_SETTLED,
    ContradictionKind.RESPONSE_IGNORED,
    ContradictionKind.ROUTE_RENDERED_NOTHING,
    ContradictionKind.ACTION_HAD_NO_EFFECT,
    ContradictionKind.DUPLICATE_REQUEST,
  ]) {
    it(`${kind} downgrades to unknown rather than claiming the action failed`, () => {
      const out = verdict([kind]);
      expect(out.verified).toBe(Verified.UNKNOWN);
      // The clause is named for what it means — evidence that had not arrived — rather than for
      // idle, which it never measured. `unsettled` beside `settled: true` was a real field report.
      expect(out.verifiedReason).toBe(VerifiedReason.EVIDENCE_INCOMPLETE);
    });
  }

  it('the reported login case now reads unknown, not no', () => {
    // The exact reproduction: signal fired with matching data, one POST still in flight.
    expect(verdict([ContradictionKind.REQUEST_NEVER_SETTLED]).verified).toBe(Verified.UNKNOWN);
  });

  it('still tells the agent what to do about it', () => {
    expect(verdict([ContradictionKind.REQUEST_NEVER_SETTLED]).because).toMatch(/re-check/i);
  });
});

describe('observed contradictions still assert failure — the catch must not regress', () => {
  for (const kind of [
    ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ContradictionKind.SIGNAL_CONTRADICTED,
    ContradictionKind.WRITE_FIELD_IGNORED,
    ContradictionKind.PARTIAL_FAILURE_IN_OK_RESPONSE,
    ContradictionKind.UNIT_MISMATCH,
    ContradictionKind.STALE_RESPONSE_APPLIED,
    ContradictionKind.FAILURE_MISATTRIBUTED,
  ]) {
    it(`${kind} still overrides a passing assertion`, () => {
      const out = verdict([kind]);
      expect(out.verified).toBe(Verified.NO);
      expect(out.verifiedReason).toBe(VerifiedReason.CONTRADICTED);
    });
  }

  it('an observed contradiction wins even when an absence-derived one is also present', () => {
    // The flagship false green — UI advanced over a failed request — arrives alongside an unsettled
    // request constantly. If the absence clause could mask it, this fix would have traded the
    // cardinal sin for the venial one.
    const out = verdict([
      ContradictionKind.REQUEST_NEVER_SETTLED,
      ContradictionKind.UI_ADVANCED_REQUEST_FAILED,
    ]);
    expect(out.verified).toBe(Verified.NO);
    expect(out.because).toContain(ContradictionKind.UI_ADVANCED_REQUEST_FAILED);
    // and does not blame the timing one for the failure
    expect(out.because).not.toContain(ContradictionKind.REQUEST_NEVER_SETTLED);
  });
});
