import { describe, expect, it } from 'vitest';
import type { SegmentRollup } from './rollups.js';
import { addSegmentToEnvelope, emptyEnvelope, type RouteEnvelope } from './envelope.js';
import { buildDeviationReport } from './deviation-report.js';

function seg(route: string, durationMs: number, over: Partial<SegmentRollup> = {}): SegmentRollup {
  return {
    route,
    from: 0,
    to: durationMs,
    durationMs,
    actions: 1,
    net: { total: 2, errors: 0 },
    consoleErrors: 0,
    statePathsChanged: [],
    ...over,
  };
}

function trained(route: string, durations: number[]): RouteEnvelope {
  let env = emptyEnvelope(route);
  for (const d of durations) env = addSegmentToEnvelope(env, seg(route, d));
  return env;
}

describe('buildDeviationReport', () => {
  it('compresses all-nominal segments to a count with a nominal headline', () => {
    const envelopes = new Map([['/a', trained('/a', [100, 110, 95, 105, 100])]]);
    const report = buildDeviationReport(envelopes, [seg('/a', 102)]);
    expect(report.deviations).toEqual([]);
    expect(report.nominalSegments).toBe(1);
    expect(report.headline).toBe('1 segment nominal');
  });

  it('ranks deviations and names the anomalous routes in the headline', () => {
    const envelopes = new Map([
      ['/a', trained('/a', [100, 110, 95, 105, 100])],
      ['/b', trained('/b', [200, 210, 190, 205, 200])],
    ]);
    const report = buildDeviationReport(envelopes, [seg('/a', 100), seg('/b', 2000)]);
    expect(report.deviations.length).toBeGreaterThanOrEqual(1);
    expect(report.deviations[0]?.route).toBe('/b');
    expect(report.headline).toContain('/b');
    expect(report.nominalSegments).toBe(1); // /a stayed in envelope
  });

  it('falls back to the causal summary when no envelope is mature enough', () => {
    const envelopes = new Map([['/a', trained('/a', [100, 110])]]); // only 2 samples
    const report = buildDeviationReport(envelopes, [seg('/a', 9999)]);
    expect(report.insufficientSamples).toBe(true);
    expect(report.judgedSegments).toBe(0);
    expect(report.headline).toContain('causal summary');
  });

  it('does not judge a truncated segment as nominal — counts it separately and notes it', () => {
    const envelopes = new Map([['/a', trained('/a', [100, 110, 95, 105, 100])]]);
    const report = buildDeviationReport(envelopes, [{ ...seg('/a', 100), truncated: true }]);
    expect(report.judgedSegments).toBe(0);
    expect(report.truncatedSegments).toBe(1);
    expect(report.nominalSegments).toBe(0);
    expect(report.headline).toContain('truncated');
  });

  it('skips segments with no route and unknown routes without crashing', () => {
    const envelopes = new Map([['/a', trained('/a', [100, 110, 95, 105, 100])]]);
    const { route: _omit, ...noRoute } = seg('/unknown', 100);
    void _omit;
    const segments = [seg('/a', 100), noRoute, seg('/never-seen', 100)];
    const report = buildDeviationReport(envelopes, segments);
    expect(report.judgedSegments).toBe(1);
  });
});
