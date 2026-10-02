import { describe, expect, it } from 'vitest';
import type { SegmentRollup } from './rollups.js';
import {
  MIN_ENVELOPE_SAMPLES,
  addSegmentToEnvelope,
  addStat,
  compareSegment,
  emptyEnvelope,
  emptyStats,
  stddev,
  zScore,
} from './envelope.js';

function seg(over: Partial<SegmentRollup> = {}): SegmentRollup {
  return {
    route: '/checkout',
    from: 0,
    to: 100,
    durationMs: 100,
    actions: 1,
    net: { total: 2, errors: 0 },
    consoleErrors: 0,
    statePathsChanged: [],
    ...over,
  };
}

describe('MetricStats (Welford)', () => {
  it('computes a running mean and sample stddev', () => {
    let s = emptyStats();
    for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) s = addStat(s, x);
    expect(s.mean).toBe(5);
    expect(stddev(s)).toBeCloseTo(2.138, 2);
    expect(s.max).toBe(9);
  });

  it('reports z=0 when there is no spread', () => {
    let s = emptyStats();
    for (const x of [100, 100, 100]) s = addStat(s, x);
    expect(zScore(s, 100)).toBe(0);
  });
});

describe('RouteEnvelope', () => {
  it('does not flag deviations until it has enough samples', () => {
    let env = emptyEnvelope('/checkout');
    env = addSegmentToEnvelope(env, seg({ durationMs: 100 }));
    env = addSegmentToEnvelope(env, seg({ durationMs: 100 }));
    // 2 samples < MIN_ENVELOPE_SAMPLES: too green to judge even a wild outlier.
    expect(env.samples).toBeLessThan(MIN_ENVELOPE_SAMPLES);
    expect(compareSegment(env, seg({ durationMs: 100_000 }))).toEqual([]);
  });

  it('flags a duration regression once the envelope is established', () => {
    let env = emptyEnvelope('/checkout');
    for (const d of [100, 110, 95, 105, 100])
      env = addSegmentToEnvelope(env, seg({ durationMs: d }));
    const deviations = compareSegment(env, seg({ durationMs: 900 }));
    expect(deviations).toHaveLength(1);
    expect(deviations[0]?.metric).toBe('durationMs');
    expect(deviations[0]?.observed).toBe(900);
  });

  it('does not flag a segment doing LESS than expected (only increases matter)', () => {
    let env = emptyEnvelope('/checkout');
    for (const d of [500, 520, 480, 510, 500])
      env = addSegmentToEnvelope(env, seg({ durationMs: d }));
    expect(compareSegment(env, seg({ durationMs: 50 }))).toEqual([]);
  });

  it('ranks multiple deviations most-severe first', () => {
    let env = emptyEnvelope('/checkout');
    const samples = [
      { durationMs: 100, net: 2 },
      { durationMs: 110, net: 3 },
      { durationMs: 95, net: 2 },
      { durationMs: 105, net: 3 },
      { durationMs: 100, net: 2 },
    ];
    for (const s of samples) {
      env = addSegmentToEnvelope(
        env,
        seg({ durationMs: s.durationMs, net: { total: s.net, errors: 0 } }),
      );
    }
    const deviations = compareSegment(env, seg({ durationMs: 900, net: { total: 40, errors: 0 } }));
    expect(deviations.length).toBeGreaterThanOrEqual(2);
    expect(deviations[0]?.z).toBeGreaterThanOrEqual(deviations[1]?.z ?? 0);
  });
});
