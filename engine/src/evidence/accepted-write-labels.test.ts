import { describe, expect, it } from 'vitest';
import { EventType, HTTP_ACCEPTED, type ReticleEvent } from '@reticlehq/core';
import { acceptedWriteLabels, hasAcceptedWrite } from './accepted-write.js';
import { decideVerified } from './verified.js';
import { buildHonestyBlock } from './honesty.js';
import { Verified } from '@reticlehq/core';

/**
 * "Re-check once it reconciles" only helps if the agent knows WHAT to re-check.
 *
 * A 202 means the server took the write and has not finished with it, so the verdict is `unknown`
 * and the agent is told to come back. In a window with several requests, a verdict saying only "a
 * write returned 202" leaves it guessing which one -- and guessing wrong means watching a call that
 * already finished while the real one is still pending.
 */

const request = (method: string, url: string, status: number): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: 1,
    data: { method, url, status },
  }) as unknown as ReticleEvent;

describe('a pending write is named, not just counted', () => {
  it('names the accepted write as method and url', () => {
    expect(acceptedWriteLabels([request('post', '/api/orders', HTTP_ACCEPTED)])).toEqual([
      'POST /api/orders',
    ]);
  });

  it('picks the pending one out of a busy window', () => {
    // The whole point. Three requests, one of them still being processed.
    const labels = acceptedWriteLabels([
      request('GET', '/api/orders', 200),
      request('POST', '/api/dispatch', HTTP_ACCEPTED),
      request('POST', '/api/telemetry', 201),
    ]);
    expect(labels).toEqual(['POST /api/dispatch']);
  });

  it('a retried call names its endpoint once', () => {
    const retried = request('POST', '/api/dispatch', HTTP_ACCEPTED);
    expect(acceptedWriteLabels([retried, retried, retried])).toHaveLength(1);
  });

  it('says nothing when no write is pending', () => {
    expect(acceptedWriteLabels([request('POST', '/api/orders', 201)])).toEqual([]);
  });

  it('the question and the list cannot disagree', () => {
    // hasAcceptedWrite is derived from the labels rather than repeating the filter, so there is no
    // way for one to count a request the other skips.
    const busy = [
      request('GET', '/api/orders', 200),
      request('POST', '/api/dispatch', HTTP_ACCEPTED),
    ];
    expect(hasAcceptedWrite(busy)).toBe(acceptedWriteLabels(busy).length > 0);
    expect(hasAcceptedWrite([])).toBe(false);
  });
});

describe('the name reaches the verdict an agent reads', () => {
  it('the because names the call to come back to', () => {
    // The unit tests above prove the list. This proves it is not computed and then dropped.
    const decision = decideVerified({
      pass: true,
      settled: true,
      declaredConsequence: true,
      outcomePending: ['POST /api/dispatch'],
      honesty: buildHonestyBlock({ grade: 'net', attribution: 'window' }),
    });
    expect(decision.verified).toBe(Verified.UNKNOWN);
    expect(decision.because).toContain('POST /api/dispatch');
    expect(decision.because).toContain('re-check that call');
  });
});
