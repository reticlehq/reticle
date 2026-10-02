/**
 * "The UI actually sent the filter" is a verdict, not a thing you read by eye (#798).
 *
 * `net.bodyContains` searches the RESPONSE only, deliberately — searching the request too would let
 * it pass on the defect it exists to catch. For a filter, a search box or a form the outgoing
 * payload IS the thing under test, and there was no way to assert on it: the reporter fell back to
 * `reticle_network { bodies: true }` and read `requestBody` by hand, which produces no verdict.
 *
 * The failure shapes matter as much as the pass. A request body that was never recorded, one that
 * was truncated, and one whose field the SDK redacted are three different unknowns, and none of them
 * is "the app sent the wrong thing".
 */
import { describe, it, expect } from 'vitest';
import { EventType, REDACTED_VALUE, type ReticleEvent } from '@reticlehq/core';
import { evaluatePredicate, type PredicateSession } from './predicate.js';

function netEvent(data: Record<string, unknown>): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    t: 10,
    data: {
      method: 'POST',
      url: 'https://app.test/api/items',
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

const FILTER = { kind: 'net', urlContains: '/api/items', method: 'POST' } as const;

async function judge(event: Record<string, unknown>, clause: Record<string, unknown>) {
  return evaluatePredicate(new WindowSession([netEvent(event)]), {
    ...FILTER,
    ...clause,
  });
}

describe('a request-body clause is a verdict on what the UI sent', () => {
  it('passes when the payload carries the value', async () => {
    const r = await judge(
      { requestBody: '{"filter":"manual_review","page":1}' },
      { requestBodyMatches: { filter: 'manual_review' } },
    );
    expect(r.pass).toBe(true);
  });

  it('ignores key order and whitespace, which a substring cannot', async () => {
    const r = await judge(
      { requestBody: '{\n  "page": 1,\n  "filter": "manual_review"\n}' },
      { requestBodyMatches: { filter: 'manual_review' } },
    );
    expect(r.pass).toBe(true);
  });

  it('supports requestBodyContains for a non-JSON payload', async () => {
    const r = await judge(
      { requestBody: 'filter=manual_review&page=1' },
      { requestBodyContains: 'filter=manual_review' },
    );
    expect(r.pass).toBe(true);
  });

  it('fails when the UI sent a different value, and says the request DID fire', async () => {
    // The point of a distinct failure: "no call matched" would send the caller to check the url and
    // the method, which are both fine.
    const r = await judge(
      { requestBody: '{"filter":"all"}' },
      { requestBodyMatches: { filter: 'manual_review' } },
    );
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('the request fired');
    expect(r.failureReason).toContain('payload is what differed');
    expect(r.assertion).toBe('net.requestBody');
  });
});

describe('the request half and the response half stay separate', () => {
  it('does not let a request value satisfy bodyContains', async () => {
    // The refund case bodyContains exists for: the app SENT 1187.01, so a field that searched both
    // halves would pass on the very defect it was written to catch.
    const r = await judge(
      { requestBody: '{"amount":"1187.01"}', responseBody: '{"refunded":11.87}' },
      { bodyContains: '"amount":"1187.01"' },
    );
    expect(r.pass).toBe(false);
  });

  it('does not let a response value satisfy a request clause', async () => {
    const r = await judge(
      { requestBody: '{"filter":"all"}', responseBody: '{"filter":"manual_review"}' },
      { requestBodyMatches: { filter: 'manual_review' } },
    );
    expect(r.pass).toBe(false);
  });
});

describe('three different unknowns, none of them "the app sent the wrong thing"', () => {
  it('an unrecorded request body names the setting that makes the assertion possible', async () => {
    const r = await judge({}, { requestBodyMatches: { filter: 'manual_review' } });
    expect(r.pass).toBe(false);
    expect(r.failureReason).toContain('captureNetworkBodies');
    expect(r.failureReason).toContain('REQUEST body');
  });

  it('a truncated request body is undecidable, not a failure', async () => {
    const r = await judge(
      { requestBody: '{"page":1,"note":"aaaa', requestBodyTruncated: true },
      { requestBodyContains: 'manual_review' },
    );
    expect(r.inconclusive, 'nothing here can say whether the rest carried it').toBeDefined();
    expect(r.inconclusive).toContain('TRUNCATED');
  });

  it('a REDACTED field is unknown, not different', async () => {
    // Request bodies are redacted before they are ever recorded, so a clause on a sensitive key is
    // unsatisfiable whatever the app sent. Calling that a mismatch blames the app for the SDK.
    const r = await judge(
      { requestBody: `{"password":"${REDACTED_VALUE}","user":"ada"}` },
      { requestBodyMatches: { password: 'hunter2' } },
    );
    expect(r.pass).toBe(false);
    expect(r.inconclusive, 'not a mismatch — nobody could have judged it').toBeDefined();
    expect(r.inconclusive).toContain('REDACTED');
    expect(r.inconclusive).toContain('password');
    expect(r.assertion).toBe('net.requestBodyMatches');
  });

  it('still judges the non-sensitive keys of a body that has a redacted one', async () => {
    const r = await judge(
      { requestBody: `{"password":"${REDACTED_VALUE}","user":"ada"}` },
      { requestBodyMatches: { user: 'ada' } },
    );
    expect(r.pass, 'redaction elsewhere in the body is not this clause`s problem').toBe(true);
  });
});
