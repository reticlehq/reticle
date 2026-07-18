import { EventType, PerfMetric } from '@reticlehq/core';
import type { Emit, Teardown } from './types.js';

/** A layout-shift entry carries the shift value + whether it followed recent input (excluded from CLS). */
interface LayoutShiftEntry extends PerformanceEntry {
  value?: number;
  hadRecentInput?: boolean;
}

/**
 * Observe the web-perf signals a screenshot tool fundamentally cannot verify — largest-contentful-paint
 * (LCP), cumulative layout shift (CLS), and long tasks — and emit them into the ring buffer so an agent
 * can assert "no layout shift on load" or "LCP under 2.5s". No-ops when PerformanceObserver or a given
 * entry type is unavailable (jsdom / older browsers), so it never throws in an unsupported context.
 *
 * Each event carries `at` (the entry's own startTime) so a consumer can reason about WHEN the metric
 * occurred rather than when it was flushed — buffered:true replays pre-install entries, whose emit time
 * would otherwise be install time.
 */
export function installPerf(emit: Emit): Teardown {
  if (typeof PerformanceObserver !== 'function') return () => undefined;
  const observers: PerformanceObserver[] = [];
  const observe = (type: string, handle: (entry: PerformanceEntry) => void): void => {
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) handle(entry);
      });
      po.observe({ type, buffered: true });
      observers.push(po);
    } catch {
      /* entry type unsupported in this browser — skip it, leave the others installed */
    }
  };

  // CLS is CUMULATIVE: sum qualifying shifts and report the running total, not each isolated shift.
  // ponytail: naive running sum — no session-windowing (5s window / 1s gap); enough for
  // "no layout shift on load" and trend, upgrade to windowed sessions if a CWV-exact number is needed.
  let cls = 0;
  // LCP only grows across candidates — surface a value only when it exceeds the last, not every candidate.
  let lcp = 0;

  observe('largest-contentful-paint', (e) => {
    const value = Math.round(e.startTime);
    if (value <= lcp) return;
    lcp = value;
    emit(EventType.PERF, { metric: PerfMetric.LCP, value, at: value });
  });
  observe('layout-shift', (e) => {
    const ls = e as LayoutShiftEntry;
    // Shifts within 500ms of a user input are expected (not CLS) — the spec's hadRecentInput flag.
    if (ls.hadRecentInput === true) return;
    cls += ls.value ?? 0;
    emit(EventType.PERF, { metric: PerfMetric.CLS, value: cls, at: Math.round(e.startTime) });
  });
  observe('longtask', (e) => {
    emit(EventType.PERF, {
      metric: PerfMetric.LONGTASK,
      value: Math.round(e.duration),
      at: Math.round(e.startTime),
    });
  });

  return () => {
    for (const po of observers) po.disconnect();
  };
}
