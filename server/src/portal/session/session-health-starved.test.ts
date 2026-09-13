/**
 * The prose half of the starved-tab caveat must follow the same polarity as the field.
 *
 * `annotateThrottledMiss` (predicate.ts) decides whether a failure was reached by NOT seeing
 * something — the only case a throttled tab casts doubt on. This layer writes that fact into the
 * `failureReason` a human reads. If it appends the sentence on its own, an absence assertion that
 * matched 13 elements is graded honestly in the field an agent gates on and simultaneously told, in
 * prose, that the tab may never have rendered. Two answers to one question is worse than either.
 *
 * So the sentence follows the field: it is appended when — and only when — the layer that owns the
 * decision made it.
 */

import { describe, expect, it } from 'vitest';
import { THROTTLED_STARVED_NOTE } from '@reticlehq/core';
import { annotateStarvedFailure } from './session-health.js';

/** The two fields `annotateStarvedFailure` reads off a Session, and nothing else. */
const throttledSession = { throttled: (): boolean => true };
const healthySession = { throttled: (): boolean => false };

type SessionLike = Parameters<typeof annotateStarvedFailure>[0];

describe('the starved-tab sentence follows the starved-tab decision', () => {
  it('appends the note when the predicate layer marked the miss inconclusive', () => {
    const annotated = annotateStarvedFailure(throttledSession as unknown as SessionLike, {
      pass: false,
      failureReason: 'no element matched',
      inconclusive: THROTTLED_STARVED_NOTE,
    });
    expect(annotated.failureReason).toContain('no element matched');
    expect(annotated.failureReason?.length).toBeGreaterThan('no element matched'.length);
  });

  it('does NOT append it to an absence failure the predicate layer deliberately left graded', () => {
    // An `absent: true` assertion that found matches. `inconclusive` is undefined ON PURPOSE — the
    // matches were seen, and a throttled tab cannot manufacture an element.
    const annotated = annotateStarvedFailure(throttledSession as unknown as SessionLike, {
      pass: false,
      failureReason: '13 matching elements found',
    });
    expect(annotated.failureReason).toBe('13 matching elements found');
  });

  it('does not append it to a failure with a more specific inconclusive reason', () => {
    // A more specific diagnosis leads, which is the same rule annotateThrottledMiss applies.
    const annotated = annotateStarvedFailure(throttledSession as unknown as SessionLike, {
      pass: false,
      failureReason: 'the locator could not be read',
      inconclusive: 'the locator could not be read',
    });
    expect(annotated.failureReason).toBe('the locator could not be read');
  });

  it('leaves a healthy session alone', () => {
    const annotated = annotateStarvedFailure(healthySession as unknown as SessionLike, {
      pass: false,
      failureReason: 'no element matched',
      inconclusive: THROTTLED_STARVED_NOTE,
    });
    expect(annotated.failureReason).toBe('no element matched');
  });
});
