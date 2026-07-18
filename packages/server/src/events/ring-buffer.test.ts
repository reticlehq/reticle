import { describe, it, expect } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { RingBuffer } from './ring-buffer.js';

function ev(t: number): ReticleEvent {
  return { t, type: EventType.NET_REQUEST, sessionId: 's', data: {} };
}

describe('RingBuffer', () => {
  it('evicts by max age relative to injected now', () => {
    const buf = new RingBuffer({ maxAgeMs: 1000, maxEvents: 100 });
    buf.push(ev(0), 0);
    buf.push(ev(500), 500);
    buf.push(ev(1600), 1600); // now=1600 -> cutoff 600 -> drops t=0 and t=500
    expect(buf.since(0).map((e) => e.t)).toEqual([1600]);
  });

  it('evicts by max count', () => {
    const buf = new RingBuffer({ maxAgeMs: 1_000_000, maxEvents: 2 });
    buf.push(ev(1), 1);
    buf.push(ev(2), 2);
    buf.push(ev(3), 3);
    expect(buf.since(0).map((e) => e.t)).toEqual([2, 3]);
  });

  it('evicts by serialized byte size', () => {
    const buf = new RingBuffer({ maxAgeMs: 1_000_000, maxEvents: 100, maxBytes: 300 });
    buf.push({ ...ev(1), data: { text: 'a'.repeat(100) } }, 1);
    buf.push({ ...ev(2), data: { text: 'b'.repeat(100) } }, 2);
    expect(buf.since(0).map((e) => e.t)).toEqual([2]);
    expect(buf.bufferHealth().dropped).toBe(1);
  });

  it('bulk age-eviction drops all expired events in one pass with correct counts', () => {
    const buf = new RingBuffer({ maxAgeMs: 100, maxEvents: 1000 });
    for (let t = 0; t < 50; t += 1) buf.push(ev(t), t); // 50 events at t=0..49
    buf.push(ev(1000), 1000); // now=1000 -> cutoff 900 -> all 50 old events expire at once
    expect(buf.since(0).map((e) => e.t)).toEqual([1000]);
    expect(buf.bufferHealth()).toEqual({ total: 1, dropped: 50 });
  });

  it('stays correct across thousands of pushes with continuous eviction (head-index + compaction)', () => {
    const buf = new RingBuffer({ maxEvents: 100, maxAgeMs: 1_000_000 });
    for (let t = 0; t < 5000; t += 1) buf.push(ev(t), t);
    const live = buf.since(0);
    expect(live).toHaveLength(100); // capped
    expect(live[0]?.t).toBe(4900); // oldest kept
    expect(live.at(-1)?.t).toBe(4999); // newest
    expect(buf.bufferHealth()).toEqual({ total: 100, dropped: 4900 });
  });

  it('respects a caller-provided byte size instead of re-serializing', () => {
    const buf = new RingBuffer({ maxAgeMs: 1_000_000, maxEvents: 100, maxBytes: 250 });
    buf.push(ev(1), 1, 200); // provided size
    buf.push(ev(2), 2, 200); // total 400 > 250 -> evict the first
    expect(buf.since(0).map((e) => e.t)).toEqual([2]);
    expect(buf.bufferHealth().dropped).toBe(1);
  });

  it('since() and window() select the right slices', () => {
    const buf = new RingBuffer({ maxAgeMs: 1_000_000, maxEvents: 100 });
    [10, 20, 30, 40].forEach((t) => buf.push(ev(t), t));
    expect(buf.since(25).map((e) => e.t)).toEqual([30, 40]);
    expect(buf.window(15, 40).map((e) => e.t)).toEqual([30, 40]); // now=40, from=25
  });
});
