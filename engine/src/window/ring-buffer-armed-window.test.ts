/**
 * A predicate's own match must survive the window it is graded in (#668).
 *
 * The reported failure: inside one `act_and_wait`, clicking Sign in fired
 * `POST /api/auth/sign-in/email` (200 in the server log), the buffer evicted it under the flood that
 * followed, and the verdict said "no network call matched urlContains sign-in". The flow was green
 * and it was graded red — and the caller could not tell, because `dropped` is a session-wide counter
 * that cannot be attributed to this assertion's own `since`.
 *
 * Pinning is bounded on purpose. When the allowance runs out the window IS evicted, and the loss is
 * recorded as scarce so `lostSince` grades the verdict undecidable. "I could not see" is an honest
 * degradation; "it did not happen" is the defect.
 */
import { describe, it, expect } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { RingBuffer } from './ring-buffer.js';

/** A non-churn event, so nothing here is eligible for the churn floor's deliberate sacrifice. */
function netEvent(t: number, url: string): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    t,
    url,
    method: 'POST',
    status: 200,
  } as unknown as ReticleEvent;
}

/** A small buffer, so the cap is reachable without pushing thousands of events. */
function buffer(maxEvents: number): RingBuffer {
  return new RingBuffer({ maxEvents, maxAgeMs: 10_000_000, maxBytes: 1_000_000_000 });
}

function urls(events: ReticleEvent[]): string[] {
  return events.map((e) => (e as unknown as { url: string }).url);
}

describe('an armed verdict window is not evicted out from under itself', () => {
  it('drops the match when nothing is armed — the reported failure', () => {
    const ring = buffer(3);
    ring.push(netEvent(100, '/api/auth/sign-in/email'), 100);
    for (let i = 0; i < 6; i++)
      ring.push(netEvent(200 + i, `/api/telemetry/${String(i)}`), 200 + i);

    expect(urls(ring.since(100))).not.toContain('/api/auth/sign-in/email');
  });

  it('keeps the match while a wait armed at that cursor is being graded', () => {
    const ring = buffer(3);
    const release = ring.protect(100);
    ring.push(netEvent(100, '/api/auth/sign-in/email'), 100);
    for (let i = 0; i < 6; i++)
      ring.push(netEvent(200 + i, `/api/telemetry/${String(i)}`), 200 + i);

    expect(urls(ring.since(100))).toContain('/api/auth/sign-in/email');
    release();
  });

  it('lets the buffer shrink back to its cap once the verdict is graded', () => {
    const ring = buffer(3);
    const release = ring.protect(100);
    ring.push(netEvent(100, '/api/auth/sign-in/email'), 100);
    for (let i = 0; i < 6; i++)
      ring.push(netEvent(200 + i, `/api/telemetry/${String(i)}`), 200 + i);
    expect(ring.bufferHealth().total).toBeGreaterThan(3);

    release();
    ring.push(netEvent(999, '/api/after'), 999);

    expect(ring.bufferHealth().total, 'the allowance is not permanent').toBeLessThanOrEqual(3);
  });

  it('protects back to the EARLIEST of two concurrent waits', () => {
    const ring = buffer(3);
    const releaseEarly = ring.protect(100);
    const releaseLate = ring.protect(500);
    ring.push(netEvent(100, '/api/auth/sign-in/email'), 100);
    for (let i = 0; i < 6; i++)
      ring.push(netEvent(500 + i, `/api/telemetry/${String(i)}`), 500 + i);

    expect(urls(ring.since(100))).toContain('/api/auth/sign-in/email');
    releaseEarly();
    releaseLate();
  });

  it('does not unprotect a cursor two waits armed on, when only one releases', () => {
    const ring = buffer(3);
    const releaseA = ring.protect(100);
    ring.protect(100);
    ring.push(netEvent(100, '/api/auth/sign-in/email'), 100);
    releaseA();
    for (let i = 0; i < 6; i++)
      ring.push(netEvent(200 + i, `/api/telemetry/${String(i)}`), 200 + i);

    expect(urls(ring.since(100))).toContain('/api/auth/sign-in/email');
  });

  it('releasing twice is harmless', () => {
    const ring = buffer(3);
    const release = ring.protect(100);
    release();
    expect(() => release()).not.toThrow();
    ring.push(netEvent(100, '/a'), 100);
    for (let i = 0; i < 6; i++) ring.push(netEvent(200 + i, `/b/${String(i)}`), 200 + i);
    expect(ring.bufferHealth().total).toBeLessThanOrEqual(3);
  });

  it('still evicts events OLDER than every armed cursor, so an armed session is not a memory leak', () => {
    const ring = buffer(3);
    ring.push(netEvent(10, '/api/ancient'), 10);
    const release = ring.protect(1000);
    for (let i = 0; i < 6; i++) ring.push(netEvent(1000 + i, `/api/live/${String(i)}`), 1000 + i);

    expect(urls(ring.since(0)), 'nothing armed covers t=10').not.toContain('/api/ancient');
    release();
  });

  it('degrades to a recorded scarce loss when the allowance runs out, not to a silent one', () => {
    // Past the overflow the window IS evicted -- the promise is bounded. What must not happen is
    // losing it silently: `lostSince` is what turns the verdict undecidable instead of red.
    const ring = buffer(3);
    const release = ring.protect(100);
    ring.push(netEvent(100, '/api/auth/sign-in/email'), 100);
    for (let i = 0; i < 2600; i++) ring.push(netEvent(200 + i, `/api/flood/${String(i)}`), 200 + i);

    expect(urls(ring.since(100))).not.toContain('/api/auth/sign-in/email');
    expect(ring.lostSince(100), 'the loss must be visible to the verdict').toBe(true);
    release();
    // Explicit: this case pushes past the overflow allowance on purpose, so it is the one test here
    // that does real work rather than a handful of events.
  }, 15_000);
});
