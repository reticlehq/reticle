import { describe, it, expect } from 'vitest';
import { EventType, PredicateKind } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import { evalNet } from './predicate-eval.js';

/**
 * #2474: a fetch or XHR sent before `connect()` is known only from resource timing, which has no
 * method. The SDK writes no method for it. A `net` clause that names a method cannot be judged on
 * that record: a plain `no` would send the caller to fix a request that the app did send.
 */
function netEvent(t: number, data: Record<string, unknown>): ReticleEvent {
  return { type: EventType.NET_REQUEST, t, data } as ReticleEvent;
}

const PRE_CONNECT = {
  id: 'n1',
  url: 'https://app.test/api/settings',
  initiator: 'fetch',
  status: 200,
  ok: true,
  durationMs: 12,
};

describe('a request whose method is not known', () => {
  it('grades a clause that names a method unknown, never a plain no', () => {
    const r = evalNet([netEvent(5, PRE_CONNECT)], {
      kind: PredicateKind.NET,
      urlContains: '/api/settings',
      method: 'PATCH',
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toContain('before connect()');
    expect(r.assertion).toBe('net.unobservable-method');
  });

  it('does not let a GET clause pass on it', () => {
    const r = evalNet([netEvent(5, PRE_CONNECT)], {
      kind: PredicateKind.NET,
      urlContains: '/api/settings',
      method: 'GET',
    });
    expect(r.pass).toBe(false);
    expect(r.inconclusive).toBeDefined();
  });

  it('still passes a clause that names no method', () => {
    const r = evalNet([netEvent(5, PRE_CONNECT)], {
      kind: PredicateKind.NET,
      urlContains: '/api/settings',
      status: 200,
    });
    expect(r.pass).toBe(true);
  });

  it('does not impeach a real match with a known method', () => {
    const r = evalNet(
      [netEvent(5, PRE_CONNECT), netEvent(6, { ...PRE_CONNECT, id: 'n2', method: 'PATCH' })],
      { kind: PredicateKind.NET, urlContains: '/api/settings', method: 'PATCH' },
    );
    expect(r.pass).toBe(true);
  });
});
