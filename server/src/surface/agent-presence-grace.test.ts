/**
 * The last agent detaching ends every browser session. A proxy that reconnects closes its stream
 * and opens a new one, so one drop of the link ended the user's session and the agent came back to
 * "no connected session". The end now waits a short grace, and a return inside it cancels the end.
 */
import { describe, expect, it } from 'vitest';
import { withDetachGrace } from './agent-presence-grace.js';

/** A timer the test fires by hand: no clock, no waiting. */
function manualTimer(): {
  schedule: (fn: () => void, ms: number) => () => void;
  fire: () => void;
  armed: () => number;
} {
  const pending = new Set<() => void>();
  return {
    schedule: (fn) => {
      pending.add(fn);
      return () => pending.delete(fn);
    },
    fire: () => {
      for (const fn of [...pending]) {
        pending.delete(fn);
        fn();
      }
    },
    armed: () => pending.size,
  };
}

describe('the last agent detaching', () => {
  it('reports an attach at once', () => {
    const seen: boolean[] = [];
    const timer = manualTimer();
    const presence = withDetachGrace((c) => seen.push(c), 10_000, timer.schedule);
    presence(true);
    expect(seen).toEqual([true]);
  });

  it('does not report the detach when the agent returns inside the grace', () => {
    const seen: boolean[] = [];
    const timer = manualTimer();
    const presence = withDetachGrace((c) => seen.push(c), 10_000, timer.schedule);
    presence(true);
    presence(false);
    presence(true);
    timer.fire();
    expect(seen).toEqual([true]);
    expect(timer.armed()).toBe(0);
  });

  it('reports the detach when the grace runs out, and the next attach after it', () => {
    const seen: boolean[] = [];
    const timer = manualTimer();
    const presence = withDetachGrace((c) => seen.push(c), 10_000, timer.schedule);
    presence(true);
    presence(false);
    expect(seen).toEqual([true]);
    timer.fire();
    expect(seen).toEqual([true, false]);
    presence(true);
    expect(seen).toEqual([true, false, true]);
  });
});
