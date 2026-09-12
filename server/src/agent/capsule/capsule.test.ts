import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { buildDivergenceCapsule } from './capsule.js';
import type { ExpectedLink } from './divergence.js';

let seq = 0;
function e(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 'demo', data };
}

describe('buildDivergenceCapsule', () => {
  it('composes summary + first divergence + blast radius on a red', () => {
    const expected: ExpectedLink[] = [
      { kind: 'net', urlContains: '/api/order', status: 200 },
      { kind: 'signal', name: 'order:placed' },
    ];
    const observed = [
      e(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 500, ok: false }),
      e(EventType.SIGNAL, { name: 'analytics:tracked' }), // undeclared → blast radius
      e(EventType.STATE_CHANGE, { name: 'toast.error' }), // undeclared → blast radius
    ];
    const capsule = buildDivergenceCapsule(expected, observed);
    expect(capsule.firstDivergence?.expected).toEqual({
      kind: 'net',
      urlContains: '/api/order',
      status: 200,
    });
    expect(capsule.summary.net.errors).toBe(1);
    expect(capsule.blastRadius).toEqual(['signal analytics:tracked', 'state toast.error']);
  });

  it('has no divergence and empty blast radius when the declared chain held cleanly', () => {
    const expected: ExpectedLink[] = [{ kind: 'signal', name: 'order:placed' }];
    const observed = [e(EventType.SIGNAL, { name: 'order:placed' })];
    const capsule = buildDivergenceCapsule(expected, observed);
    expect(capsule.firstDivergence).toBeNull();
    expect(capsule.blastRadius).toEqual([]);
  });
});

/**
 * The blast radius was blind to the channel that carries the damage.
 *
 * It walked signals and store changes and ignored NETWORK entirely — so an action that satisfied
 * every consequence it declared and also fired a request nobody asked for came back with an empty
 * radius. That is the shape the whole idea exists for: a click that works AND posts somewhere else,
 * which is how a "green" that did extra damage gets shipped. A signal and a store change are the
 * cheap half; a request is the half that leaves the machine.
 *
 * Declared requests are matched by `urlContains`, the same way the divergence walk matches them, so
 * a flow that declared `/api/order` is not told about `/api/order` — it asked for that one.
 */
describe('requests nobody declared', () => {
  it('reports one fired alongside a consequence that HELD', () => {
    const expected: ExpectedLink[] = [{ kind: 'signal', name: 'order:placed' }];
    const observed = [
      e(EventType.SIGNAL, { name: 'order:placed' }),
      e(EventType.NET_REQUEST, { method: 'POST', url: '/api/analytics/track', status: 200 }),
    ];
    const capsule = buildDivergenceCapsule(expected, observed);
    // Vacuity: the declared consequence held, so this is a GREEN action with a side effect.
    expect(capsule.firstDivergence).toBeNull();
    expect(capsule.blastRadius).toEqual(['net POST /api/analytics/track']);
  });

  it('says nothing about a request the action declared', () => {
    const expected: ExpectedLink[] = [{ kind: 'net', urlContains: '/api/order' }];
    const observed = [
      e(EventType.NET_REQUEST, { method: 'POST', url: '/api/order/42', status: 200 }),
    ];
    expect(buildDivergenceCapsule(expected, observed).blastRadius).toEqual([]);
  });

  it('reports an undeclared request even when another one WAS declared', () => {
    const expected: ExpectedLink[] = [{ kind: 'net', urlContains: '/api/order' }];
    const observed = [
      e(EventType.NET_REQUEST, { method: 'POST', url: '/api/order/42', status: 200 }),
      e(EventType.NET_REQUEST, { method: 'DELETE', url: '/api/cart', status: 200 }),
    ];
    expect(buildDivergenceCapsule(expected, observed).blastRadius).toEqual([
      'net DELETE /api/cart',
    ]);
  });

  it('does not repeat the same call twice', () => {
    const expected: ExpectedLink[] = [];
    const observed = [
      e(EventType.NET_REQUEST, { method: 'GET', url: '/api/me', status: 200 }),
      e(EventType.NET_REQUEST, { method: 'GET', url: '/api/me', status: 200 }),
    ];
    expect(buildDivergenceCapsule(expected, observed).blastRadius).toEqual(['net GET /api/me']);
  });
});
