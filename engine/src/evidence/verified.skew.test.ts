/**
 * A verdict served over a skewed wire is `unknown`, never `yes`.
 *
 * Reported from the field: `reticle verify --expect ...` printed `verified: yes` and exited 0 while
 * its own evidence block reported `versionSkew` — two different wire-contract hashes between the
 * page SDK and the daemon — and partial coverage. The reporter's response was the correct one:
 *
 *   "Expected: unknown or nonzero exit when wire incompatibility makes evidence untrustworthy.
 *    Current approach: discard the green verdict and verify independently."
 *
 * An agent that trusts the exit code ships on a green its own tool contradicted in the same payload.
 *
 * Why `unknown` and not `no`: nothing was disproved. `reticle_session` already warns that under skew
 * "dispatched/settled may be silent no-ops" — which is a statement that the EVIDENCE is unreliable,
 * not that the app is broken. `unknown` is exactly the value the vocabulary has for that, and it is
 * the same shape as the `capability-absent` clause directly above: a channel nobody could read
 * honestly produces no verdict rather than a guess.
 *
 * It is ordered with that clause, ahead of everything else, for the same reason. A skewed link makes
 * the ACTION unreliable, so there is no point grading the quality of an observation of something
 * that may never have happened — which is the argument `session-health` already makes when it ranks
 * skew above the throttle warning.
 */

import { describe, expect, it } from 'vitest';
import { Verified, VerifiedReason } from '@reticlehq/core';
import { decideVerified } from './verified.js';
import { HonestyGrade, type HonestyBlock } from './honesty.js';

const honesty: HonestyBlock = {
  grade: HonestyGrade.SIGNAL,
  attribution: 'window',
  coverage: { partial: false },
  integrity: { clean: true, issues: [] },
};

const clean = { honesty, settled: true, declaredConsequence: true } as const;

describe('a verdict over a skewed wire', () => {
  it('is unknown even when the assertion passed', () => {
    const out = decideVerified({ ...clean, pass: true, versionSkew: 'page 2.14.0 / daemon 3.2.0' });
    expect(out.verified).toBe(Verified.UNKNOWN);
  });

  it('names the skew in the reason, so the agent can act on it', () => {
    const out = decideVerified({ ...clean, pass: true, versionSkew: 'page 2.14.0 / daemon 3.2.0' });
    expect(out.because).toContain('2.14.0');
  });

  it('does not call it a failure — nothing about the app was disproved', () => {
    const out = decideVerified({ ...clean, pass: false, versionSkew: 'wire a1 / wire b2' });
    expect(out.verified).toBe(Verified.UNKNOWN);
  });

  /** Without skew, the same inputs still reach the ordinary green. This is a new clause, not a new mood. */
  it('leaves an unskewed pass alone', () => {
    const out = decideVerified({ ...clean, pass: true });
    expect(out.verified).toBe(Verified.YES);
  });

  it('leaves an unskewed failure alone', () => {
    const out = decideVerified({ ...clean, pass: false });
    expect(out.verified).toBe(Verified.NO);
  });

  /** An empty string is not a skew. Only a real mismatch may cost a verdict. */
  it('treats an empty skew string as no skew', () => {
    const out = decideVerified({ ...clean, pass: true, versionSkew: '' });
    expect(out.verified).toBe(Verified.YES);
  });

  it('uses its own reason rather than borrowing capability-absent', () => {
    const out = decideVerified({ ...clean, pass: true, versionSkew: 'page 2.14.0 / daemon 3.2.0' });
    expect(out.verifiedReason).toBe(VerifiedReason.VERSION_SKEW);
  });
});
