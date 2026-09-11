import { describe, it, expect } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { evalSettled, evalConsole, matchValue } from './predicate-eval.js';

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

  it('counts a REUSED request id correctly — a retry that reuses an id stays in-flight', () => {
    // Two NET_PENDING share id 'r1' (a retry reused it), only one completed. Set-membership marked the
    // id "done" and hid the second still-flying request → premature settle. Per-id counting catches it.
    const events = [
      ev(EventType.NET_PENDING, { id: 'r1', url: '/api/save' }, 100),
      ev(EventType.NET_REQUEST, { id: 'r1', url: '/api/save', status: 200 }, 200),
      ev(EventType.NET_PENDING, { id: 'r1', url: '/api/save' }, 300), // retry, same id, not yet done
    ];
    const r = evalSettled(events, { kind: 'settled', quietMs: 500 }, 100_000);
    expect(r.pass).toBe(false);
    expect((r.evidence as { inFlight: number }).inFlight).toBe(1);
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

describe('matchValue — an operator-less object does not vacuously match everything', () => {
  it('an empty {} matches ONLY an equal literal, never any value (the fail-open false green)', () => {
    // `{}` used to enter the operator branch, iterate zero operators, and return true — so `equals: {}`
    // passed against a number, a string, even undefined. An assertion that asserts nothing is the
    // exact false green the oracle exists to prevent.
    expect(matchValue(42, {})).toBe(false);
    expect(matchValue('x', {})).toBe(false);
    expect(matchValue(undefined, {})).toBe(false);
    expect(matchValue(null, {})).toBe(false);
  });

  it('a real operator still works, and a non-$ literal object compares by equality', () => {
    expect(matchValue(5, { $gte: 3 })).toBe(true);
    expect(matchValue(2, { $gte: 3 })).toBe(false);
    // A non-operator object (no `$` key) is a literal — not a container that vacuously passes.
    //
    // Compared by VALUE. This line used to pin `false` with the note "strict eq, no deep-equal
    // (unchanged behavior)", which was recording what the code did while a different false green was
    // being fixed, not a claim that reference equality is right. It is not: the expected side is
    // parsed from the agent's JSON and is a fresh object every time, so `equals` against any array or
    // object was an assertion no state could ever satisfy. See match-value-structural.
    expect(matchValue({ id: 1 }, { id: 1 })).toBe(true);
    expect(matchValue({ id: 1 }, { id: 2 })).toBe(false);
    expect(matchValue('*', '*') || matchValue('anything', '*')).toBe(true); // `*` presence unaffected
  });
});
