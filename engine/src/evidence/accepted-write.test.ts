import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { hasAcceptedWrite } from './accepted-write.js';

const call = (data: Record<string, unknown>): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: 10,
    data: { url: '/api/x', ...data },
  }) as unknown as ReticleEvent;

describe('a write the server has not finished processing', () => {
  it('reports a 202 Accepted', () => {
    expect(hasAcceptedWrite([call({ method: 'POST', status: 202 })])).toBe(true);
  });

  it('stays silent on an ordinary 2xx', () => {
    expect(hasAcceptedWrite([call({ method: 'POST', status: 200 })])).toBe(false);
  });

  // The same split every other rule uses: the dev toolchain is not the app under test, and a verdict
  // about the app must not be decided by traffic the app did not make.
  it('stays silent for the dev toolchain answering 202', () => {
    expect(
      hasAcceptedWrite([
        call({ method: 'POST', url: '/__nextjs_original-stack-frames', status: 202 }),
      ]),
    ).toBe(false);
  });

  it("still reports the APP's 202 in the same window", () => {
    expect(
      hasAcceptedWrite([
        call({ method: 'POST', url: '/__nextjs_original-stack-frames', status: 202 }),
        call({ method: 'POST', url: '/api/dispatch', status: 202 }),
      ]),
    ).toBe(true);
  });
});
