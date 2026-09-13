import { describe, expect, it } from 'vitest';
import { createWatchBatcher } from './watch-batcher.js';

/** A manual scheduler: captures the pending callback so the test decides when the quiet window fires. */
function manualScheduler() {
  let pending: (() => void) | undefined;
  return {
    schedule: (fn: () => void): void => {
      pending = fn;
    },
    fire: (): void => {
      const fn = pending;
      pending = undefined;
      fn?.();
    },
  };
}

describe('createWatchBatcher', () => {
  it('coalesces a burst of changes into one flush of unique files', () => {
    const scheduler = manualScheduler();
    const flushes: string[][] = [];
    const batcher = createWatchBatcher({
      debounceMs: 50,
      schedule: scheduler.schedule,
      onFlush: (files) => flushes.push(files),
    });

    batcher.onChange('a.ts');
    batcher.onChange('b.ts');
    batcher.onChange('a.ts'); // duplicate
    expect(flushes).toHaveLength(0); // nothing flushed until the window fires
    scheduler.fire();

    expect(flushes).toEqual([['a.ts', 'b.ts']]);
  });

  it('starts a fresh window for changes after a flush', () => {
    const scheduler = manualScheduler();
    const flushes: string[][] = [];
    const batcher = createWatchBatcher({
      debounceMs: 50,
      schedule: scheduler.schedule,
      onFlush: (f) => flushes.push(f),
    });

    batcher.onChange('a.ts');
    scheduler.fire();
    batcher.onChange('c.ts');
    scheduler.fire();

    expect(flushes).toEqual([['a.ts'], ['c.ts']]);
  });

  it('does not flush an empty window', () => {
    const scheduler = manualScheduler();
    const flushes: string[][] = [];
    createWatchBatcher({
      debounceMs: 50,
      schedule: scheduler.schedule,
      onFlush: (f) => flushes.push(f),
    });
    scheduler.fire(); // never fired since nothing scheduled
    expect(flushes).toEqual([]);
  });
});
