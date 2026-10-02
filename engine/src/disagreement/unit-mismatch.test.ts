import { describe, expect, it } from 'vitest';
import { ContradictionKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { findUnitMismatches } from './unit-mismatch.js';

const call = (
  url: string,
  opts: { request?: unknown; response?: unknown; method?: string },
): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: 10,
    data: {
      method: opts.method ?? 'POST',
      url,
      status: 200,
      ...(opts.request === undefined ? {} : { requestBody: JSON.stringify(opts.request) }),
      ...(opts.response === undefined ? {} : { responseBody: JSON.stringify(opts.response) }),
    },
  }) as unknown as ReticleEvent;

/** The read that states the API's units, as it happens on a real dashboard before any write. */
const listing = call('/api/v1/payments', {
  method: 'GET',
  response: { items: [{ id: 'pay_NkT10001', amount: 118701, currency: 'INR' }] },
});

describe('money sent back at the wrong scale', () => {
  it('reports a major-unit number written into a minor-unit field', () => {
    const found = findUnitMismatches([
      listing,
      call('/api/v1/payments/pay_NkT10001/refund', {
        request: { amount: 1187.01, speed: 'normal' },
        response: { id: 'rfnd_1', status: 'processed' },
      }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(ContradictionKind.UNIT_MISMATCH);
    expect(found[0]?.counter).toContain('100x SMALLER');
    expect(found[0]?.counter).toContain('118701');
  });

  it('handles three-decimal currencies, and a NUMERIC id in the path', () => {
    // `/api/orders/9/capture` is at least as common as a prefixed id, and a bare `9` cannot be
    // pattern-matched out of arbitrary text — it is resolved from the path segment instead.
    const found = findUnitMismatches([
      call('/api/orders', { method: 'GET', response: { id: 9, amount: 45250 } }),
      call('/api/orders/9/capture', { request: { amount: 45.25 } }),
    ]);
    expect(found[0]?.counter).toContain('1000x SMALLER');
  });

  it('stays silent when the app sends the SAME units the API stated', () => {
    expect(
      findUnitMismatches([
        listing,
        call('/api/v1/payments/pay_NkT10001/refund', { request: { amount: 118701 } }),
      ]),
    ).toEqual([]);
  });

  it('stays silent for an API that legitimately speaks major units throughout', () => {
    // Nothing here is at two scales — the comparison, not the decimal point, is what fires.
    expect(
      findUnitMismatches([
        call('/api/invoices', { method: 'GET', response: { id: 'inv_1', amount: 1187.01 } }),
        call('/api/invoices/inv_1/pay', { request: { amount: 1187.01 } }),
      ]),
    ).toEqual([]);
  });

  it('stays silent for a partial amount — a different number is not a different SCALE', () => {
    expect(
      findUnitMismatches([
        listing,
        call('/api/v1/payments/pay_NkT10001/refund', { request: { amount: 50000 } }),
      ]),
    ).toEqual([]);
  });

  it('stays silent when the entity was never described', () => {
    expect(
      findUnitMismatches([
        call('/api/v1/payments/pay_UNSEEN/refund', { request: { amount: 1187.01 } }),
      ]),
    ).toEqual([]);
  });

  it('does not compare a request against its own response', () => {
    expect(
      findUnitMismatches([
        call('/api/v1/payments/pay_X1234/refund', {
          request: { amount: 1187.01 },
          response: { id: 'pay_X1234', amount: 118701 },
        }),
      ]),
    ).toEqual([]);
  });

  it('reports each entity+field once, however many times it is retried', () => {
    const refund = call('/api/v1/payments/pay_NkT10001/refund', { request: { amount: 1187.01 } });
    expect(findUnitMismatches([listing, refund, refund, refund])).toHaveLength(1);
  });

  it('ignores non-money fields at a coincidental scale', () => {
    expect(
      findUnitMismatches([
        call('/api/v1/payments', {
          method: 'GET',
          response: { id: 'pay_A1234', amount: 100, weightGrams: 40000 },
        }),
        call('/api/v1/payments/pay_A1234/ship', { request: { weightGrams: 400 } }),
      ]),
    ).toEqual([]);
  });
});
