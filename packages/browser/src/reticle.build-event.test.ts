import { describe, it, expect } from 'vitest';
import { EventType } from '@reticlehq/core';
import { buildEvent } from './reticle.js';

describe('buildEvent', () => {
  it('stamps the injected seq and clock time on the envelope', () => {
    const e = buildEvent({
      seq: 3,
      t: 120,
      type: EventType.SIGNAL,
      sessionId: 's1',
      data: { name: 'x' },
    });
    expect(e.seq).toBe(3);
    expect(e.t).toBe(120);
    expect(e.type).toBe(EventType.SIGNAL);
    expect(e.sessionId).toBe('s1');
    expect(e.data).toEqual({ name: 'x' });
  });

  it('passes the optional ref through and omits it when absent', () => {
    expect(
      buildEvent({ seq: 0, t: 0, type: EventType.DOM_ADDED, sessionId: 's', data: {}, ref: 'e7' })
        .ref,
    ).toBe('e7');
    expect(
      buildEvent({ seq: 0, t: 0, type: EventType.DOM_ADDED, sessionId: 's', data: {} }).ref,
    ).toBeUndefined();
  });
});
