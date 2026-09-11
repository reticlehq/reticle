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
