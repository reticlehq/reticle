import { describe, it, expect } from 'vitest';
import { EventType, PredicateKind } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import { evalNet } from './predicate-eval.js';

/**
 * A failure nobody can un-fail should not cost the caller the rest of the budget.
 *
 * Proving a negative usually DOES require spending it: "the toast never appeared" is only knowable
 * at the end, and cutting the wait short there would manufacture false negatives, which is the one
 * mistake this codebase will not trade for speed. Measured across the fleet, the slow verdicts are
 * almost all exactly that, and they are inherent.
 *
 * Exact cardinality is the exception, because it is MONOTONIC. A window only ever accumulates
 * matches, so once more than N have arrived, no later event can bring the count back down to N. The
 * answer is already final and the remaining budget buys nothing.
 *
 * It is also the case where waiting hurts most: an exceeded count IS the double-submit — two writes
 * fired 59ms apart — so the highest-value finding in the predicate surface was the slowest to
 * report. A caller who granted 30 seconds waited all of them to be told about something that had
 * already finished happening.
 */
function netEvent(t: number, data: Record<string, unknown>): ReticleEvent {
  return { type: EventType.NET_REQUEST, t, data } as ReticleEvent;
}

const POST = { method: 'POST', url: '/api/refund', status: 200, ok: true };

describe('evalNet marks an exceeded exact count as decided', () => {
  it('sets decided when more matches than declared have already arrived', () => {
    const r = evalNet([netEvent(10, POST), netEvent(69, POST)], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      count: 1,
    });
    expect(r.pass).toBe(false);
    expect(r.decided, 'a count can only rise, so this can never become true').toBe(true);
  });

  it('does NOT set decided while the count is still short of the target', () => {
    // The second request may yet arrive. Ending here would be the false negative the budget exists
    // to prevent.
    const r = evalNet([netEvent(10, POST)], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      count: 2,
    });
    expect(r.pass).toBe(false);
    expect(r.decided ?? false).toBe(false);
  });

  it('does not set decided on a presence miss, where a later request could still match', () => {
    const r = evalNet([], { kind: PredicateKind.NET, urlContains: '/api/refund' });
    expect(r.pass).toBe(false);
    expect(r.decided ?? false).toBe(false);
  });

  it('does not set decided on a wrong-status miss — a retry could still match', () => {
    // Deliberate: a 500 now does not mean a 200 will not follow. This is the case it would be
    // tempting to call decided, and it is not one.
    const r = evalNet([netEvent(10, { ...POST, status: 500, ok: false })], {
      kind: PredicateKind.NET,
      urlContains: '/api/refund',
      status: 200,
    });
    expect(r.pass).toBe(false);
    expect(r.decided ?? false).toBe(false);
  });
});
