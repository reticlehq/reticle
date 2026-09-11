import { describe, it, expect } from 'vitest';
import { createCommitAggregator } from './commit-aggregator.js';

/** A manual scheduler capturing the tick so the test controls when a window flushes. */
function manualScheduler() {
  let tick: (() => void) | undefined;
  return {
    schedule: (fn: () => void): void => {
      tick = fn;
    },
    fire: (): void => {
      const fn = tick;
      tick = undefined;
      fn?.();
    },
  };
}

describe('createCommitAggregator', () => {
  it('flushes the accumulated commit count once per window', () => {
    const scheduler = manualScheduler();
    const flushes: number[] = [];
    const agg = createCommitAggregator({
      schedule: scheduler.schedule,
      flush: (n) => flushes.push(n),
    });

    agg.onCommit();
    agg.onCommit();
    agg.onCommit();
    expect(flushes).toEqual([]); // nothing until the window fires
    scheduler.fire();

    expect(flushes).toEqual([3]); // a storm shows up as one event of magnitude 3
  });

  it('starts a fresh window after a flush', () => {
    const scheduler = manualScheduler();
    const flushes: number[] = [];
    const agg = createCommitAggregator({
      schedule: scheduler.schedule,
      flush: (n) => flushes.push(n),
    });

    agg.onCommit();
    scheduler.fire();
    agg.onCommit();
    agg.onCommit();
    scheduler.fire();

    expect(flushes).toEqual([1, 2]);
  });

  it('does not flush an empty window', () => {
    const scheduler = manualScheduler();
    const flushes: number[] = [];
    createCommitAggregator({ schedule: scheduler.schedule, flush: (n) => flushes.push(n) });
    scheduler.fire();
    expect(flushes).toEqual([]);
  });
});
