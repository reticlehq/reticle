import { afterEach, describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import { installPerf } from './perf.js';
import type { Emit } from './types.js';

/** Controllable PerformanceObserver double (jsdom has none). One instance per observed entry type. */
class FakePerformanceObserver {
  static instances: FakePerformanceObserver[] = [];
  observedType = '';
  constructor(private readonly cb: (list: { getEntries: () => PerformanceEntry[] }) => void) {
    FakePerformanceObserver.instances.push(this);
  }
  observe(opts: { type: string }): void {
    this.observedType = opts.type;
  }
  disconnect(): void {
    /* no-op */
  }
  fire(entries: PerformanceEntry[]): void {
    this.cb({ getEntries: () => entries });
  }
}

function collect(): { emit: Emit; events: { type: EventType; data: Record<string, unknown> }[] } {
  const events: { type: EventType; data: Record<string, unknown> }[] = [];
  return { emit: (type, data) => events.push({ type, data }), events };
}

describe('installPerf', () => {
  const orig = globalThis.PerformanceObserver;
  afterEach(() => {
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver = orig;
    FakePerformanceObserver.instances = [];
  });

  it('emits PERF events for LCP, CLS (excluding recent-input shifts), and long tasks', () => {
    (globalThis as unknown as { PerformanceObserver: unknown }).PerformanceObserver =
      FakePerformanceObserver;
    const { emit, events } = collect();
    const teardown = installPerf(emit);

    const byType = (t: string) =>
      FakePerformanceObserver.instances.find((o) => o.observedType === t);
    byType('largest-contentful-paint')?.fire([{ startTime: 1234.6 } as PerformanceEntry]);
    byType('layout-shift')?.fire([
      { value: 0.12, hadRecentInput: false } as unknown as PerformanceEntry,
      { value: 0.9, hadRecentInput: true } as unknown as PerformanceEntry, // input-driven → excluded
    ]);
    byType('longtask')?.fire([{ duration: 80 } as PerformanceEntry]);
    teardown();

    const perf = events.filter((e) => e.type === EventType.PERF).map((e) => e.data);
    expect(perf).toContainEqual({ metric: 'lcp', value: 1235 });
    expect(perf).toContainEqual({ metric: 'cls', value: 0.12 });
    expect(perf).toContainEqual({ metric: 'longtask', value: 80 });
    expect(perf.filter((p) => p['metric'] === 'cls')).toHaveLength(1); // the recent-input shift dropped
  });

  it('no-ops without PerformanceObserver', () => {
    (globalThis as unknown as { PerformanceObserver: undefined }).PerformanceObserver = undefined;
    const { emit, events } = collect();
    expect(() => installPerf(emit)()).not.toThrow();
    expect(events).toHaveLength(0);
  });
});
