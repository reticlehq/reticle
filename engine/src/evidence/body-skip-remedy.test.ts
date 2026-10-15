/**
 * #1520 (review): every remedy that says "enable captureNetworkBodies" follows the stamped reason.
 *
 * `evalNet` was fixed first. The shared `bodyCaptureRemedy` still told the agent to switch capture
 * on when it was already on and the SDK had skipped a stream, and so did its callers: the
 * `OUTCOME_UNREAD` verdict, the `bodiesNotCaptured` note on a network listing, the `compare`
 * predicate, and the request-body clause. Each now reads the reason the SDK stamped.
 */

import { describe, expect, it } from 'vitest';
import {
  EventType,
  ResponseBodyReason,
  Verified,
  VerifiedReason,
  type ReticleEvent,
} from '@reticlehq/core';
import { bodyCaptureRemedy } from './body-capture-remedy.js';
import { bodiesNotCaptured, captureProvedOn } from './uncaptured-bodies.js';
import { unreadWriteLabels, unreadWriteReason } from './unread-outcome.js';
import { decideVerified } from './verified.js';
import { evalNet } from '@/question/predicate/predicate-eval.js';

let seq = 0;
function call(data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return {
    t: seq,
    seq,
    type: EventType.NET_REQUEST,
    sessionId: 's',
    data: {
      id: `n${String(seq)}`,
      method: 'POST',
      url: '/api/orders',
      status: 201,
      responseSize: 42,
      ...data,
    },
  };
}

describe('bodyCaptureRemedy follows the stamped reason', () => {
  it.each([
    ResponseBodyReason.STREAMING,
    ResponseBodyReason.NOT_TEXT,
    ResponseBodyReason.UNREADABLE,
  ])('a %s body: capture is already on, so the remedy does not name the setting', (reason) => {
    const remedy = bodyCaptureRemedy('3.7.0', reason);
    expect(remedy).toContain('capture is already on');
    expect(remedy).not.toContain('captureNetworkBodies');
  });

  it('no reason: the capture remedy, as before', () => {
    expect(bodyCaptureRemedy('3.7.0', undefined)).toContain('captureNetworkBodies');
  });

  it('error-status marks a body recorded with capture OFF, so the capture remedy stands', () => {
    expect(bodyCaptureRemedy('3.7.0', ResponseBodyReason.ERROR_STATUS)).toContain(
      'captureNetworkBodies',
    );
  });
});

describe('the OUTCOME_UNREAD verdict', () => {
  it('names the stream, not the setting, when every unread write was a skipped stream', () => {
    const events = [call({ responseBodyReason: ResponseBodyReason.STREAMING })];
    const verdict = decideVerified({
      pass: true,
      honesty: { integrity: { clean: true } },
      settled: true,
      outcomeUnread: unreadWriteLabels(events),
      outcomeUnreadReason: unreadWriteReason(events),
    } as unknown as Parameters<typeof decideVerified>[0]);
    expect(verdict.verified).toBe(Verified.UNKNOWN);
    expect(verdict.verifiedReason).toBe(VerifiedReason.OUTCOME_UNREAD);
    expect(verdict.because).toContain('streamed');
    expect(verdict.because).not.toContain('captureNetworkBodies');
  });

  it('reads no shared reason when the unread writes disagree', () => {
    const events = [
      call({ responseBodyReason: ResponseBodyReason.STREAMING }),
      call({ url: '/api/other' }),
    ];
    expect(unreadWriteReason(events)).toBeUndefined();
  });
});

describe('the bodiesNotCaptured note', () => {
  const post = [{ method: 'POST' }];

  it('stays silent when a call proves capture is on', () => {
    const proved = captureProvedOn([call({ responseBodyReason: ResponseBodyReason.STREAMING })]);
    expect(proved).toBe(true);
    expect(bodiesNotCaptured(post, '3.7.0', proved)).toEqual({});
  });

  it('a request body type also proves capture is on', () => {
    expect(captureProvedOn([call({ requestBodyType: 'FormData' })])).toBe(true);
  });

  it('error-status does not prove capture is on', () => {
    expect(captureProvedOn([call({ responseBodyReason: ResponseBodyReason.ERROR_STATUS })])).toBe(
      false,
    );
    expect(bodiesNotCaptured(post, '3.7.0', false).bodiesNotCaptured).toContain(
      'captureNetworkBodies',
    );
  });
});

describe('the request-body clause', () => {
  it('names the body type, not the setting, when capture is on and the body was a Blob', () => {
    const r = evalNet([call({ requestBodyType: 'Blob' })], {
      kind: 'net',
      urlContains: '/api/orders',
      requestBodyContains: 'sku',
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('Blob');
    expect(r.inconclusive).not.toContain('captureNetworkBodies');
  });

  it('keeps the capture remedy when no type was named', () => {
    const r = evalNet([call({})], {
      kind: 'net',
      urlContains: '/api/orders',
      requestBodyContains: 'sku',
    });
    expect(r.inconclusive).toContain('captureNetworkBodies');
  });
});
