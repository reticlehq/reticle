import { describe, expect, it } from 'vitest';
import { canFollow } from './flow-composition.js';
import type { FlowFile } from './flow-types.js';
import { PredicateKind } from '@/verdict/consequence.js';
import type { Predicate } from '@/verdict/predicate.js';

/**
 * Composition is checkable before anything runs, or it is a hope.
 *
 * Two flows that each pass alone can fail composed, and the reverse. Until a flow could SAY what it
 * needs and what it leaves, a suite replaying journeys back to back either got lucky or produced a
 * red that looked like a regression and was a missing precondition — the most expensive failure
 * there is, because it sends a reader into product code that is fine.
 */
const flow = (over: Partial<FlowFile>): FlowFile => ({
  version: 1,
  name: 'f',
  createdAt: 0,
  steps: [],
  ...over,
});

const SIGNED_IN: Predicate = { kind: PredicateKind.SIGNAL, name: 'auth:ready' };
const CART_FULL: Predicate = { kind: PredicateKind.SIGNAL, name: 'cart:filled' };

describe('whether one flow may replay straight after another', () => {
  it('allows it when everything the next flow requires is ensured by the previous one', () => {
    const check = canFollow(flow({ ensures: [SIGNED_IN] }), flow({ requires: [SIGNED_IN] }));
    expect(check.ok).toBe(true);
    expect(check.unmet).toEqual([]);
    expect(check.unchecked).toBe(false);
  });

  it('names what is undischarged rather than answering a bare no', () => {
    // A boolean sends the reader to diff two files by eye. The claim itself is the actionable thing.
    const check = canFollow(
      flow({ ensures: [SIGNED_IN] }),
      flow({ requires: [SIGNED_IN, CART_FULL] }),
    );
    expect(check.ok).toBe(false);
    expect(check.unmet).toEqual([CART_FULL]);
  });

  it('is permissive when the next flow declares nothing, and says the answer was unchecked', () => {
    /*
     * Every flow recorded before this shipped declares neither. Treating "did not say" as "does not
     * satisfy" would refuse every existing composition on the day it landed, which is a worse
     * failure than the one this prevents — so silence is permitted and REPORTED, never silently
     * counted as safe.
     */
    const check = canFollow(flow({}), flow({}));
    expect(check.ok).toBe(true);
    expect(check.unchecked).toBe(true);
  });

  it('does not call it unchecked when the previous flow did declare something', () => {
    const check = canFollow(flow({ ensures: [SIGNED_IN] }), flow({}));
    expect(check.ok).toBe(true);
    expect(check.unchecked).toBe(false);
  });

  it('matches claims by value, so an equal claim written twice is the same claim', () => {
    const check = canFollow(
      flow({ ensures: [{ kind: PredicateKind.SIGNAL, name: 'auth:ready' }] }),
      flow({ requires: [{ kind: PredicateKind.SIGNAL, name: 'auth:ready' }] }),
    );
    expect(check.ok).toBe(true);
  });
});
