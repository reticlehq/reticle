import { afterEach, describe, expect, it } from 'vitest';
import { EventType, PerfMetric } from '@reticlehq/core';
import { installPerf } from './perf.js';
import type { Emit } from './types.js';

/** Controllable PerformanceObserver double (jsdom has none). One instance per observed entry type. */
class FakePerformanceObserver {
  static instances: FakePerformanceObserver[] = [];
  /** Entry types whose observe() should throw, simulating an unsupported type in this browser. */
  static throwOnTypes = new Set<string>();
  observedType = '';
  disconnectCount = 0;
  constructor(private readonly cb: (list: { getEntries: () => PerformanceEntry[] }) => void) {
    FakePerformanceObserver.instances.push(this);
  }
  observe(opts: { type: string }): void {
    if (FakePerformanceObserver.throwOnTypes.has(opts.type))
      throw new Error('unsupported entry type');
    this.observedType = opts.type;
  }
  disconnect(): void {
    this.disconnectCount += 1;
  }
  fire(entries: PerformanceEntry[]): void {
    this.cb({ getEntries: () => entries });
  }
}

function collect(): { emit: Emit; events: { type: EventType; data: Record<string, unknown> }[] } {
  const events: { type: EventType; data: Record<string, unknown> }[] = [];
  return { emit: (type, data) => events.push({ type, data }), events };
}

const byType = (t: string): FakePerformanceObserver | undefined =>
  FakePerformanceObserver.instances.find((o) => o.observedType === t);

describe('installPerf', () => {
  const orig = globalThis.PerformanceObserver;
  afterEach(() => {
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver = orig;
    FakePerformanceObserver.instances = [];
    FakePerformanceObserver.throwOnTypes = new Set();
  });

  const install = (): ReturnType<typeof installPerf> & {
    events: ReturnType<typeof collect>['events'];
  } => {
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver =
      FakePerformanceObserver;
    const { emit, events } = collect();
    const teardown = installPerf(emit) as ReturnType<typeof installPerf> & {
      events: typeof events;
    };
    return Object.assign(teardown, { events });
  };

  it('emits PERF events for LCP, CLS (excluding recent-input shifts), and long tasks, each with `at`', () => {
    const t = install();
    byType('largest-contentful-paint')?.fire([{ startTime: 1234.6 } as PerformanceEntry]);
    byType('layout-shift')?.fire([
      { value: 0.12, startTime: 500, hadRecentInput: false } as unknown as PerformanceEntry,
      { value: 0.9, startTime: 510, hadRecentInput: true } as unknown as PerformanceEntry, // input-driven → excluded
    ]);
    byType('longtask')?.fire([{ duration: 80, startTime: 700 } as PerformanceEntry]);
    t();

    const perf = t.events.filter((e) => e.type === EventType.PERF).map((e) => e.data);
    expect(perf).toContainEqual({ metric: PerfMetric.LCP, value: 1235, at: 1235 });
    expect(perf).toContainEqual({ metric: PerfMetric.CLS, value: 0.12, at: 500 });
    expect(perf).toContainEqual({ metric: PerfMetric.LONGTASK, value: 80, at: 700 });
    expect(perf.filter((p) => p['metric'] === PerfMetric.CLS)).toHaveLength(1);
  });

  it('accumulates CLS across shifts (cumulative, not per-shift)', () => {
    const t = install();
    const ls = byType('layout-shift');
    ls?.fire([
      { value: 0.1, startTime: 100, hadRecentInput: false } as unknown as PerformanceEntry,
    ]);
    ls?.fire([
      { value: 0.05, startTime: 200, hadRecentInput: false } as unknown as PerformanceEntry,
    ]);
    t();
    const cls = t.events.map((e) => e.data).filter((d) => d['metric'] === PerfMetric.CLS);
    expect(cls.map((d) => d['value'])).toEqual([0.1, expect.closeTo(0.15, 5)]); // running total
  });

  it('emits LCP only when a candidate exceeds the previous (no duplicate smaller candidates)', () => {
    const t = install();
    const lcp = byType('largest-contentful-paint');
    lcp?.fire([{ startTime: 800 } as PerformanceEntry]);
    lcp?.fire([{ startTime: 500 } as PerformanceEntry]); // smaller → ignored
    lcp?.fire([{ startTime: 1200 } as PerformanceEntry]); // larger → emitted
    t();
    const values = t.events
      .map((e) => e.data)
      .filter((d) => d['metric'] === PerfMetric.LCP)
      .map((d) => d['value']);
    expect(values).toEqual([800, 1200]);
  });

  it('an unsupported entry type does not prevent the others from installing', () => {
    FakePerformanceObserver.throwOnTypes = new Set(['layout-shift']);
    const t = install();
    expect(byType('largest-contentful-paint')).toBeDefined(); // installed despite layout-shift throwing
    expect(byType('longtask')).toBeDefined();
    byType('longtask')?.fire([{ duration: 40, startTime: 10 } as PerformanceEntry]);
    t();
    expect(t.events.some((e) => e.data['metric'] === PerfMetric.LONGTASK)).toBe(true);
  });

  it('teardown disconnects every installed observer', () => {
    const t = install();
    const installed = FakePerformanceObserver.instances.filter((o) => o.observedType !== '');
    expect(installed.length).toBeGreaterThan(0);
    t();
    expect(installed.every((o) => o.disconnectCount === 1)).toBe(true);
  });

  it('no-ops without PerformanceObserver', () => {
    (globalThis as unknown as { PerformanceObserver: undefined }).PerformanceObserver = undefined;
    const { emit, events } = collect();
    expect(() => installPerf(emit)()).not.toThrow();
    expect(events).toHaveLength(0);
  });
});
