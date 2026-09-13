import { describe, it, expect } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { RingBuffer } from './ring-buffer.js';

/**
 * What makes an act window's capture UNCLEAN.
 *
 * `act_and_wait` used to decide that by watching the cumulative drop counter move across the call:
 * `bufferHealth().dropped > droppedBefore`. That counter increments for every eviction the buffer
 * has ever made, and two of the three eviction paths have nothing to do with the window:
 *
 *   - AGE. Anything older than `maxAgeMs` (60s) is evicted on every push, so any session older than
 *     a minute with a heartbeat, a poll or an animation running drops something during every call.
 *   - CHURN. The buffer deliberately sacrifices the low-signal floor first — that is the policy that
 *     keeps scarce evidence alive, and it is a success, not a loss.
 *
 * So on a live app the flag was essentially always true, and `decideVerified` turned it into
 * `verified: "unknown" / unclean_capture`. In the field this became the dominant cause of every
 * `unknown` verdict: Reticle drove the app, saw the whole window, and refused to report what it saw.
 *
 * The honest question is narrow: did we evict a NON-CHURN event that belonged to this window?
 */
function ev(type: ReticleEvent['type'], t: number): ReticleEvent {
  return { t, type, sessionId: 's', data: {} };
}

describe('a window is impeached only by evidence lost from inside it', () => {
  it('does not impeach a window when age eviction retired events from before it', () => {
    // The 20% case. A minute-old session, a window opened now, nothing in it lost.
    const buf = new RingBuffer({ maxAgeMs: 1000, maxEvents: 100 });
    for (let t = 0; t <= 900; t += 100) buf.push(ev(EventType.NET_REQUEST, t), t);
    const since = 2000;
    buf.push(ev(EventType.NET_REQUEST, since), since); // now=2000 -> cutoff 1000 -> retires all ten
    expect(buf.bufferHealth().dropped).toBeGreaterThan(0);
    expect(buf.lostSince(since)).toBe(false);
  });

  it('does not impeach a window when only the churn floor was sacrificed inside it', () => {
    // Dropping churn is the eviction policy working. It is what keeps the failed request alive.
    const buf = new RingBuffer({ maxEvents: 20, maxAgeMs: 1_000_000 });
    buf.push(ev(EventType.NET_REQUEST, 1), 1);
    for (let i = 0; i < 200; i++) buf.push(ev(EventType.DOM_TEXT, 2 + i), 2 + i);
    expect(buf.bufferHealth().dropped).toBeGreaterThan(0);
    expect(buf.since(0).some((e) => e.type === EventType.NET_REQUEST)).toBe(true);
    expect(buf.lostSince(1)).toBe(false);
  });

  it('impeaches a window when scarce evidence inside it was evicted', () => {
    // The case the flag exists for: the buffer filled with high-signal events and fell back to FIFO,
    // so something the verdict might have depended on is genuinely gone.
    const buf = new RingBuffer({ maxEvents: 10, maxAgeMs: 1_000_000 });
    for (let i = 0; i < 100; i++) buf.push(ev(EventType.SIGNAL, i), i);
    expect(buf.lostSince(0)).toBe(true);
  });

  it('reports the loss only against windows that opened before it', () => {
    const buf = new RingBuffer({ maxEvents: 10, maxAgeMs: 1_000_000 });
    for (let i = 0; i < 100; i++) buf.push(ev(EventType.SIGNAL, i), i);
    // Everything evicted was at t < 90; a window opened at 90 lost nothing.
    expect(buf.lostSince(0)).toBe(true);
    expect(buf.lostSince(95)).toBe(false);
  });

  it('is false on a buffer that has never evicted anything', () => {
    const buf = new RingBuffer({ maxEvents: 100, maxAgeMs: 1_000_000 });
    buf.push(ev(EventType.NET_REQUEST, 1), 1);
    expect(buf.lostSince(0)).toBe(false);
  });
});
