import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './parallel.js';

describe('Cloudflare verification scheduler', () => {
  it('runs work concurrently up to the requested bound and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const values = await mapWithConcurrency(['a', 'b', 'c', 'd'], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 'a' === value ? 10 : 1));
      active -= 1;
      return value.toUpperCase();
    });

    expect(peak).toBe(2);
    expect(values).toEqual(['A', 'B', 'C', 'D']);
  });

  it('clamps invalid or excessive concurrency to useful bounds', async () => {
    let calls = 0;
    const values = await mapWithConcurrency([1, 2], 99, (value) => {
      calls += 1;
      return Promise.resolve(value * 2);
    });
    expect(values).toEqual([2, 4]);
    expect(calls).toBe(2);
  });
});
