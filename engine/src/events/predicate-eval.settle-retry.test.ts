/**
 * `settled` is the most-waited-on predicate in the product — `act_and_wait{until:settled}` is what
 * an agent calls after almost every action — and it was paying up to a full poll interval of dead
 * time on every single wait.
 *
 * Measured across the nine-app fixture fleet with RETICLE_TRACE: `reticle_wait_for` and
 * `reticle_act_and_wait` are bimodal, either ~0ms (already true) or 566–627ms. The 500ms is
 * DEFAULT_QUIET_MS, which is the DEFINITION of settled and must not change. The remainder is the
 * 150ms backstop poll landing wherever it happens to land — pure latency, ~75ms on average, on the
 * hottest verification call there is.
 *
 * The fix is a hint, not a shortcut: a quiet-window failure knows exactly when it could first pass,
 * so it says so, and the waiter re-checks THEN instead of on the next blind tick. Nothing about the
 * pass decision moves — the predicate is still evaluated at that later moment and can still fail.
 */

import { describe, expect, it } from 'vitest';
import { EventType, PredicateKind } from '@reticlehq/core';
import { evalSettled } from './predicate-eval.js';
import type { ReticleEvent } from '@reticlehq/core';

const settled = { kind: PredicateKind.SETTLED } as const;

function domEventAt(t: number): ReticleEvent {
  return { type: EventType.DOM_ADDED, t, seq: 1, data: {} } as unknown as ReticleEvent;
}

describe('evalSettled — says when it could next pass', () => {
  it('reports the exact remaining quiet time when it fails on the window', () => {
    // Last activity 200ms ago: 300ms of quiet still owed.
    const r = evalSettled([domEventAt(1000)], settled, 1200);
    expect(r.pass).toBe(false);
    expect(r.retryAfterMs).toBe(300);
  });

  it('offers no hint when the hold-up is an in-flight request, which has no known end', () => {
    const pending = {
      type: EventType.NET_PENDING,
      t: 1000,
      seq: 1,
      data: { id: 'r1' },
    } as unknown as ReticleEvent;
    const r = evalSettled([pending], settled, 1200);
    expect(r.pass).toBe(false);
    // A request in flight settles when the SERVER answers. Guessing a time here would send the
    // waiter back on a schedule that has nothing to do with the thing it is waiting for.
    expect(r.retryAfterMs).toBeUndefined();
  });

  it('carries no hint once it passes — there is nothing to retry', () => {
    const r = evalSettled([domEventAt(1000)], settled, 1600);
    expect(r.pass).toBe(true);
    expect(r.retryAfterMs).toBeUndefined();
  });

  it('honours a caller-supplied quietMs rather than the default', () => {
    const r = evalSettled([domEventAt(1000)], { ...settled, quietMs: 100 }, 1050);
    expect(r.pass).toBe(false);
    expect(r.retryAfterMs).toBe(50);
  });
});
