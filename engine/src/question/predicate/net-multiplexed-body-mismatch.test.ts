/**
 * On a multiplexed endpoint, a `net` miss must report the response of the call that matched the
 * request side — not the first unrelated call whose response also failed the body clause (#1365).
 *
 * A single URL may carry many query types (e.g. `POST /v1/queries` with `op: thread.get` vs
 * `op: search`). Before the fix, the response-body clause ran BEFORE `checkRequestBody`, so an
 * unrelated call's response was recorded as `bodyMismatch` even though that call never matched the
 * request filter. The miss then named the wrong body.
 */
import { describe, it, expect } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

function netEvent(data: Record<string, unknown>): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    t: 10,
    data: {
      method: 'POST',
      url: 'https://app.test/v1/queries',
      status: 200,
      ok: true,
      ...data,
    },
  } as unknown as ReticleEvent;
}

class WindowSession implements PredicateSession {
  constructor(private readonly events: readonly ReticleEvent[]) {}
  command(): Promise<never> {
    return Promise.reject(new Error('no element commands in these tests'));
  }
  eventsSince(): ReticleEvent[] {
    return [...this.events];
  }
  onEvent(): () => void {
    return () => undefined;
  }
  elapsed(): number {
    return 100;
  }
}

const MULTIPLEXED_PREDICATE = {
  kind: 'net',
  urlContains: '/v1/queries',
  method: 'POST',
  requestBodyMatches: { op: 'thread.get' },
  bodyMatches: { result: 'found' },
} as const;

describe('a net miss on a multiplexed endpoint names the request-matching call (#1365)', () => {
  it('reports the target call response, not an unrelated call on the same URL', async () => {
    const unrelatedCall = netEvent({
      requestBody: '{"op":"search","query":"hello"}',
      responseBody: '{"results":[],"count":0}',
    });
    const targetCall = netEvent({
      requestBody: '{"op":"thread.get","thread_id":"t-123"}',
      responseBody: '{"result":"not_found","error":"thread missing"}',
    });

    const r = await evaluatePredicate(
      new WindowSession([unrelatedCall, targetCall]),
      MULTIPLEXED_PREDICATE,
    );

    expect(r.pass).toBe(false);
    // The observed response must be the target call's body (the one that matched requestBodyMatches).
    expect(r.observed).toContain('not_found');
    expect(r.observed).toContain('thread missing');
    // It must NOT name the unrelated call's response body.
    expect(r.observed).not.toContain('"count":0');
    expect(r.observed).not.toContain('"results":[]');
  });

  it('still reports a request-body mismatch when no call matches the request side', async () => {
    const unrelatedCall = netEvent({
      requestBody: '{"op":"search","query":"hello"}',
      responseBody: '{"results":[]}',
    });
    const anotherUnrelated = netEvent({
      requestBody: '{"op":"delete","id":"x"}',
      responseBody: '{"deleted":true}',
    });

    const r = await evaluatePredicate(
      new WindowSession([unrelatedCall, anotherUnrelated]),
      MULTIPLEXED_PREDICATE,
    );

    expect(r.pass).toBe(false);
    // No call matched requestBodyMatches, so the request-body verdict must win.
    expect(r.assertion).toBe('net.requestBody');
    expect(r.failureReason).toContain('the request fired');
  });

  it('passes when the request-matching call also matches the response body', async () => {
    const unrelatedCall = netEvent({
      requestBody: '{"op":"search"}',
      responseBody: '{"results":[]}',
    });
    const targetCall = netEvent({
      requestBody: '{"op":"thread.get"}',
      responseBody: '{"result":"found"}',
    });

    const r = await evaluatePredicate(
      new WindowSession([unrelatedCall, targetCall]),
      MULTIPLEXED_PREDICATE,
    );

    expect(r.pass).toBe(true);
  });

  it('request matchCount is independent of matches.length when response body is unrecorded', async () => {
    // A call matches the request side but has no recorded response body. The request-body verdict
    // must NOT fire (matchCount > 0); instead the matched-but-unrecorded verdict must win.
    const targetCall = netEvent({
      requestBody: '{"op":"thread.get"}',
      // no responseBody field
    });

    const r = await evaluatePredicate(new WindowSession([targetCall]), MULTIPLEXED_PREDICATE);

    expect(r.pass).toBe(false);
    expect(r.assertion).toBe('net.bodyContains');
    expect(r.failureReason).toContain('body was not recorded');
  });
});
