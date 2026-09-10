/**
 * `verify_change` answered "no" for a suite that verified NOTHING.
 *
 * Reported from a sweep: the same call on the same uncovered file answered `no` on five apps and
 * `unknown` on two — and all five also emitted `bug_found`, which is most of why the headline
 * "bugs found" number was counting Reticle's own failures.
 *
 * The cause is a regression I introduced. `flow_verify` used to report `pass` for a suite with no
 * flows, which was a false green and got fixed — it now reports `unverifiable`. But this tool asks
 * `suite.status !== 'pass'`, so `unverifiable` fell into the FAILED branch: a suite that proved
 * nothing came back as proof the change was broken.
 *
 * `unverifiable` is the same fact as "no flow covers this", which this tool already answers with
 * UNKNOWN and its own comment calls "the honest answer, never a green: nothing ran, so nothing was
 * proved". Reporting it as a failure is the mirror-image error: a red that nothing earned.
 */

import { describe, expect, it } from 'vitest';
import { Verified } from '@reticlehq/core';
import { verdictForSuite } from './verify-change-verdict.js';

describe('the verdict a suite status earns', () => {
  it('a passing suite proves the change is fine', () => {
    expect(verdictForSuite('pass', 0)).toBe(Verified.YES);
  });

  it('a FAILING suite proves it is not', () => {
    expect(verdictForSuite('fail', 1)).toBe(Verified.NO);
  });

  it('an UNVERIFIABLE suite proves nothing, either way', () => {
    // Not a failure. Nothing ran that could fail.
    expect(verdictForSuite('unverifiable', 0)).toBe(Verified.UNKNOWN);
  });

  it('failures outrank an unverifiable status — a real red is still a red', () => {
    expect(verdictForSuite('unverifiable', 2)).toBe(Verified.NO);
  });

  it('an unrecognised status is UNKNOWN, never a pass and never a failure', () => {
    expect(verdictForSuite('something-new', 0)).toBe(Verified.UNKNOWN);
  });
});
