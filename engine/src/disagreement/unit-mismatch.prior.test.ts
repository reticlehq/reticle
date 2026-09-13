import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findUnitMismatches } from './unit-mismatch.js';

const net = (data: Record<string, unknown>, t: number): ReticleEvent =>
  ({ type: EventType.NET_REQUEST, t, data }) as unknown as ReticleEvent;

/** GET /api/payments — where the API states the amount in minor units. */
const statesAmount = net(
  {
    id: 'n1',
    method: 'GET',
    url: 'http://localhost:8787/api/payments',
    status: 200,
    ok: true,
    responseBody: JSON.stringify({
      payments: [{ id: 'pay_NkT10001', amount: 118701, currency: 'INR' }],
    }),
  },
  1,
);

/** POST the rendered major-unit number back into the same field. A 100x under-refund. */
const refundsWrongScale = net(
  {
    id: 'n2',
    method: 'POST',
    url: 'http://localhost:8787/api/payments/pay_NkT10001/refund',
    status: 200,
    ok: true,
    requestBody: JSON.stringify({ amount: 1187.01 }),
    responseBody: JSON.stringify({ status: 'processed' }),
  },
  2,
);

/**
 * The scale error is a disagreement with a value the API stated EARLIER — by definition before the
 * action that sends it. But `reticle_assert` scopes its window to the last act's cursor
 * (observe-tools.ts: `asNumber(args['since']) ?? session.lastAct.cursor() ?? 0`), so the GET that
 * established 118701 falls outside it and `known` is empty when the refund is examined.
 *
 * Measured live on the bench-app payments panel: `reticle_observe` over a wide window reported
 * `unit-mismatch`, while `reticle_assert` on the very same session reported NO contradictions and
 * `verified: yes`. The verdict tool — the one an agent gates on — was the blind one.
 *
 * Widening the assert window is the wrong fix: action-scoped attribution is what stops every other
 * rule blaming an action for events it did not cause. Prior events are used ONLY to learn what the
 * API said; findings are still emitted solely for requests inside the window.
 */
describe('unit-mismatch can see what the API said before the window', () => {
  it('fires when the stating GET is prior history and the write is in the window', () => {
    const found = findUnitMismatches([refundsWrongScale], [statesAmount]);
    expect(found.map((c) => c.kind)).toContain(ContradictionKind.UNIT_MISMATCH);
    expect(found[0]?.counter).toContain('118701');
  });

  it('still fires when both are inside the window (the existing behaviour)', () => {
    const found = findUnitMismatches([statesAmount, refundsWrongScale]);
    expect(found.map((c) => c.kind)).toContain(ContradictionKind.UNIT_MISMATCH);
  });

  it('stays silent when the API never stated an amount for that entity', () => {
    expect(findUnitMismatches([refundsWrongScale], [])).toEqual([]);
  });

  it('does not report a write that happened only in prior history', () => {
    // Prior events teach; they are not themselves findings, or every assert would re-report every
    // earlier mistake as though this action had just made it.
    expect(findUnitMismatches([], [statesAmount, refundsWrongScale])).toEqual([]);
  });
});
