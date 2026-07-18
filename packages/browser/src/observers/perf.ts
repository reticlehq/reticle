import { EventType } from '@reticlehq/core';
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
      /* entry type unsupported in this browser — skip it */
    }
  };

  observe('largest-contentful-paint', (e) => {
    emit(EventType.PERF, { metric: 'lcp', value: Math.round(e.startTime) });
  });
  observe('layout-shift', (e) => {
    const ls = e as LayoutShiftEntry;
    // Shifts within 500ms of a user input are expected (not CLS) — the spec's hadRecentInput flag.
    if (ls.hadRecentInput !== true) emit(EventType.PERF, { metric: 'cls', value: ls.value ?? 0 });
  });
  observe('longtask', (e) => {
    emit(EventType.PERF, { metric: 'longtask', value: Math.round(e.duration) });
  });

  return () => {
    for (const po of observers) po.disconnect();
  };
}
