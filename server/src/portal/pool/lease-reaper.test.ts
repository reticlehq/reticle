/**
 * LeaseReaper drives the pool's sweepExpired on an interval. Verified with a fake-timer clock so no
 * real waiting is needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseReaper } from './lease-reaper.js';
import type { BrowserPool } from './browser-pool.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LeaseReaper', () => {
  it('calls sweepExpired on each interval tick until stopped', async () => {
    let sweeps = 0;
    const pool = {
      sweepExpired: (): Promise<string[]> => {
        sweeps += 1;
        return Promise.resolve([]);
      },
    } as unknown as BrowserPool;

    const reaper = new LeaseReaper(pool, 1000);
    reaper.start();
    expect(sweeps).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sweeps).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sweeps).toBe(3);

    reaper.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sweeps).toBe(3); // no more ticks after stop
  });

  it('start is idempotent (a second start does not double the cadence)', async () => {
    let sweeps = 0;
    const pool = {
      sweepExpired: (): Promise<string[]> => {
        sweeps += 1;
        return Promise.resolve([]);
      },
    } as unknown as BrowserPool;

    const reaper = new LeaseReaper(pool, 1000);
    reaper.start();
    reaper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweeps).toBe(1);
    reaper.stop();
  });
});
