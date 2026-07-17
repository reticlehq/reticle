import { describe, it, expect } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { evalSettled, evalConsole } from './predicate-eval.js';

function ev(type: EventType, data: Record<string, unknown>, t: number): ReticleEvent {
  return { t, type, sessionId: 's', data };
}

describe('evalSettled — in-flight requests are not settled', () => {
  it('is NOT settled while a request is in flight (NET_PENDING with no completion)', () => {
    // Request started at t=100, never completed; DOM went quiet long ago.
    const events = [ev(EventType.NET_PENDING, { id: 'r1', url: '/api/save' }, 100)];
    const now = 100_000; // hours later — DOM is quiet, but the save is still flying
    const r = evalSettled(events, { kind: 'settled', quietMs: 500 }, now);
    expect(r.pass).toBe(false); // false-green guard: green must not mean "still saving"
  });

  it('IS settled once the in-flight request completes and the page goes quiet', () => {
    const events = [
      ev(EventType.NET_PENDING, { id: 'r1', url: '/api/save' }, 100),
      ev(EventType.NET_REQUEST, { id: 'r1', url: '/api/save', status: 200 }, 200),
    ];
    const now = 1000; // 800ms after completion, quietMs=500
    const r = evalSettled(events, { kind: 'settled', quietMs: 500 }, now);
    expect(r.pass).toBe(true);
  });
});

describe('evalConsole — uncaptured levels do not false-pass', () => {
  it('does NOT silently pass an `absent` assertion for an uncaptured level (info)', () => {
    // Reticle only instruments console.log/warn/error. An `absent: info` assertion verifies nothing,
    // so it must not report green.
    const r = evalConsole([], { kind: 'console', level: 'info', absent: true });
    expect(r.pass).toBe(false);
  });

  it('still evaluates a captured level (log) normally', () => {
    const withLog = [ev(EventType.CONSOLE_LOG, { text: 'hi' }, 10)];
    expect(evalConsole(withLog, { kind: 'console', level: 'log' }).pass).toBe(true);
    expect(evalConsole([], { kind: 'console', level: 'log', absent: true }).pass).toBe(true);
  });
});
