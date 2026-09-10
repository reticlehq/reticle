/**
 * A negative verdict about a file, from flows that admit they may have nothing to do with it.
 *
 * Observed in a sweep: `verified: "no"`, because "1 of 1 covering flows failed (1 of them re-run only
 * because Reticle cannot tell which sources they cover)". Re-running an unattributable flow is right
 * — better to over-run than silently skip — but then declaring "your change to src/App.tsx is broken"
 * on the strength of a flow that may cover something else entirely is a claim the evidence does not
 * support.
 *
 * This tool already refuses the mirror-image error: an UNCOVERED change is UNKNOWN, never a green,
 * with the comment "the honest answer, never a green: nothing ran, so nothing was proved". A red
 * nothing earned is the same mistake pointing the other way.
 *
 * So: a NO must be earned by a failing flow that is genuinely attributed to the changed files. If
 * every failing flow is in `unknownProvenance`, the answer is UNKNOWN — and it says which case it is,
 * because "we could not tell" and "your change is fine" are different things.
 */

import { describe, expect, it } from 'vitest';
import { attributedFailures } from './attributed-failure.js';

describe('which failing flows can support a verdict about the change', () => {
  it('a failing flow with known provenance is attributed', () => {
    expect(attributedFailures(['checkout'], ['legacy-smoke'])).toEqual(['checkout']);
  });

  it('a failing flow that only ran because provenance is unknown is NOT', () => {
    // The reported case: the single failure is the unattributable one.
    expect(attributedFailures(['legacy-smoke'], ['legacy-smoke'])).toEqual([]);
  });

  it('keeps the attributed ones when a run mixes both', () => {
    expect(attributedFailures(['checkout', 'legacy-smoke'], ['legacy-smoke'])).toEqual([
      'checkout',
    ]);
  });

  it('is empty for an empty failure list', () => {
    expect(attributedFailures([], ['legacy-smoke'])).toEqual([]);
  });

  it('attributes everything when nothing is of unknown provenance', () => {
    expect(attributedFailures(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});
