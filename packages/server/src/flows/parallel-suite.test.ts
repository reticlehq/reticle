import { describe, expect, it } from 'vitest';
import { mapWithConcurrency, resolveConcurrency } from './parallel-suite.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('mapWithConcurrency (parallel suite scheduler)', () => {
  it('preserves INPUT order even when items finish out of order', async () => {
    // A suite verdict must be stable: flow 3 finishing first cannot reorder the report.
    const out = await mapWithConcurrency(['a', 'b', 'c'], 3, async (item) => {
      await tick('a' === item ? 30 : 'b' === item ? 10 : 1);
      return item.toUpperCase();
    });
    expect(out.map((o) => o.value)).toEqual(['A', 'B', 'C']);
  });

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick(5);
        inFlight -= 1;
        return true;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually parallel, not accidentally serialized
  });

  it('captures a per-item failure instead of sinking the whole suite', async () => {
    // A suite that aborts on the first crash tells you nothing about the other flows.
    const out = await mapWithConcurrency(['ok1', 'boom', 'ok2'], 2, (item) =>
      'boom' === item ? Promise.reject(new Error('flow crashed')) : Promise.resolve(item),
    );
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    expect(out[1]?.error).toBe('flow crashed');
    expect(out[2]?.value).toBe('ok2');
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(
      Array.from({ length: 25 }, (_, i) => i),
      4,
      async (item) => {
        seen.push(item);
        await tick(1);
        return item;
      },
    );
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('a zero/negative cap still makes progress (never deadlocks)', async () => {
    const out = await mapWithConcurrency([1, 2], 0, (n) => Promise.resolve(n * 2));
    expect(out.map((o) => o.value)).toEqual([2, 4]);
  });

  it('handles an empty suite', async () => {
    expect(await mapWithConcurrency([], 4, () => Promise.resolve(1))).toEqual([]);
  });
});

describe('resolveConcurrency', () => {
  it('never exceeds the flow count or the pool capacity', () => {
    expect(resolveConcurrency(3, 8)).toBe(3); // fewer flows than slots
    expect(resolveConcurrency(50, 6)).toBe(6); // pool is the ceiling
  });

  it('honours an explicit request within the ceiling, and clamps a silly one', () => {
    expect(resolveConcurrency(50, 6, 2)).toBe(2);
    expect(resolveConcurrency(50, 6, 999)).toBe(6);
    expect(resolveConcurrency(50, 6, 0)).toBe(6); // nonsense → default ceiling, never 0
  });

  it('never returns less than 1', () => {
    expect(resolveConcurrency(0, 0)).toBe(1);
  });
});
