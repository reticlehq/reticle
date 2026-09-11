import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { firstDivergence, type ExpectedLink } from './divergence.js';

let seq = 0;
function e(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 'demo', data };
}

describe('firstDivergence', () => {
  it('returns null when the whole declared chain held', () => {
    const expected: ExpectedLink[] = [
      { kind: 'net', urlContains: '/api/order', status: 200 },
      { kind: 'signal', name: 'order:placed' },
    ];
    const observed = [
      e(EventType.NET_REQUEST, { url: 'http://x/api/order', status: 200 }),
      e(EventType.SIGNAL, { name: 'order:placed' }),
    ];
    expect(firstDivergence(expected, observed)).toBeNull();
  });

  it('names the first failing link — a hidden-500 (request fired but 500, not 200)', () => {
    const expected: ExpectedLink[] = [
      { kind: 'net', urlContains: '/api/order', status: 200 },
      { kind: 'signal', name: 'order:placed' },
    ];
    const observed = [e(EventType.NET_REQUEST, { url: 'http://x/api/order', status: 500 })];
    const divergence = firstDivergence(expected, observed);
    expect(divergence?.expected).toEqual({ kind: 'net', urlContains: '/api/order', status: 200 });
    expect(divergence?.observed).toContain('500');
    expect(divergence?.observed).toContain('expected 200');
  });

  it('names a hung-request (no request reached the endpoint at all)', () => {
    const expected: ExpectedLink[] = [{ kind: 'net', urlContains: '/api/order', status: 200 }];
    const divergence = firstDivergence(expected, []);
    expect(divergence?.observed).toContain('no request to /api/order');
  });

  it('stops at the FIRST divergence, not a later one', () => {
    const expected: ExpectedLink[] = [
      { kind: 'signal', name: 'validated' }, // fails first
      { kind: 'signal', name: 'order:placed' },
    ];
    const divergence = firstDivergence(expected, []);
    expect(divergence?.expected).toEqual({ kind: 'signal', name: 'validated' });
  });

  /**
   * A state link is spelled with whichever half the predicate gave — `store` if it named one, and the
   * `path` otherwise (see predicateToExpectedLinks). The event carries BOTH, and this only ever
   * compared the store, so every assertion written by path answered "never changed" no matter what
   * the app did.
   *
   * Seen on bench-app: `{ kind: "state", path: "view", equals: "compose" }` after clicking Compose
   * produced `firstDivergence: state "view" never changed` in a response whose own `stateDiffs` read
   * `{ path: "view", from: "deployments", to: "compose" }`. Two contradictory claims about one event,
   * side by side, and the false one was the one an agent would act on.
   *
   * There was no state case in this file at all, which is how it survived.
   */
  it('matches a state link written by PATH, not only by store', () => {
    const expected: ExpectedLink[] = [{ kind: 'state', name: 'view' }];
    const observed = [e(EventType.STATE_CHANGE, { name: 'app', path: 'view', value: 'compose' })];
    expect(
      firstDivergence(expected, observed),
      'the path changed, so there is no divergence to report',
    ).toBeNull();
  });

  it('still matches a state link written by STORE', () => {
    const expected: ExpectedLink[] = [{ kind: 'state', name: 'app' }];
    const observed = [e(EventType.STATE_CHANGE, { name: 'app', path: 'view', value: 'compose' })];
    expect(firstDivergence(expected, observed)).toBeNull();
  });

  it('still reports a state link that genuinely never changed', () => {
    // The direction that must not soften: a path nothing touched is a real divergence.
    const expected: ExpectedLink[] = [{ kind: 'state', name: 'cart' }];
    const observed = [e(EventType.STATE_CHANGE, { name: 'app', path: 'view', value: 'compose' })];
    expect(firstDivergence(expected, observed)?.observed).toContain('never changed');
  });
});
