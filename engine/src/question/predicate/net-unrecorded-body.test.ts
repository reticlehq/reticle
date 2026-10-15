/**
 * #1520: a body clause over a call whose body was not recorded is `unknown`, never `no`.
 *
 * With body capture on, the SDK still skips some bodies on purpose: a streamed response
 * (`text/event-stream`, for example a streamable-HTTP MCP endpoint) is never read, because reading
 * it would hang the app. `bodyContains` over such a call answered `pass: false` with no
 * `inconclusive`, so the verdict was `no`, "as if the body lacked the text", and the message told
 * the caller to enable `captureNetworkBodies`, which was already on.
 *
 * The SDK now stamps `responseBodyReason` on a body it skips, and the clause is inconclusive with a
 * reason and a remedy that fit it. The `captureNetworkBodies` remedy is for a call with no reason:
 * capture was off, or the SDK predates the field.
 */

import { describe, expect, it } from 'vitest';
import { EventType, ResponseBodyReason, type ReticleEvent } from '@reticlehq/core';
import { evalNet } from './predicate-eval.js';
import type { Predicate } from './predicate-schema.js';

let seq = 0;
function call(data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return {
    t: seq,
    seq,
    type: EventType.NET_REQUEST,
    sessionId: 's',
    data: { id: `n${String(seq)}`, method: 'POST', url: '/mcp', status: 200, ...data },
  };
}

type NetPredicate = Extract<Predicate, { kind: 'net' }>;
const CONTAINS: NetPredicate = {
  kind: 'net',
  urlContains: '/mcp',
  bodyContains: 'resource_timeout',
};
const MATCHES: NetPredicate = { kind: 'net', urlContains: '/mcp', bodyMatches: { ok: false } };

describe('a body clause over a body that was not recorded', () => {
  it('is unknown, and says the response was streamed, when the SDK skipped a stream', () => {
    const r = evalNet([call({ responseBodyReason: ResponseBodyReason.STREAMING })], CONTAINS);
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('streamed');
    // The remedy fits the reason: capture is on, so enabling it changes nothing.
    expect(r.inconclusive).not.toContain('captureNetworkBodies');
    expect(r.inconclusive).toMatch(/DOM|state/);
  });

  it('is unknown, and names the content type, for a body that is not text', () => {
    const r = evalNet([call({ responseBodyReason: ResponseBodyReason.NOT_TEXT })], CONTAINS);
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('not text');
    expect(r.inconclusive).not.toContain('captureNetworkBodies');
  });

  it('is unknown, and says the read did not finish, for an unreadable body', () => {
    const r = evalNet([call({ responseBodyReason: ResponseBodyReason.UNREADABLE })], MATCHES);
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('could not be read');
    expect(r.inconclusive).not.toContain('captureNetworkBodies');
  });

  it('is unknown with the capture remedy when no reason was stamped', () => {
    const r = evalNet([call({})], CONTAINS);
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('captureNetworkBodies');
  });

  it('still says no when a recorded body lacks the text', () => {
    const r = evalNet([call({ responseBody: '{"ok":true}' })], CONTAINS);
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeUndefined();
  });

  it('still passes when a recorded body has the text', () => {
    const r = evalNet([call({ responseBody: 'data: {"error":"resource_timeout"}' })], CONTAINS);
    expect(r.pass).toBe(true);
  });
});

describe('a request-body clause over a request body that was not recorded', () => {
  it('is unknown, not a plain no', () => {
    const r = evalNet([call({})], {
      kind: 'net',
      urlContains: '/mcp',
      requestBodyContains: 'tools/call',
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('REQUEST body was not recorded');
  });
});
