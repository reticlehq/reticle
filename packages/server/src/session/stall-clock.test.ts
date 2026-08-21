import { afterEach, describe, expect, it, vi } from 'vitest';
import { markStallClock, resetStallClock, STALL_AFTER_MS, stallUptime } from './stall-clock.js';
import * as appInstrumented from '../telemetry/app-instrumented.js';

/**
 * What survived the removal of `instrumentation_stalled`. The event went; the clock stayed, because
 * two live features read it and neither is a metric: the no-session diagnosis tells an agent how
 * long this daemon has waited, and the daemon warns on stderr once a run passes the threshold.
 */
describe('stallUptime', () => {
  afterEach(() => {
    resetStallClock();
    vi.restoreAllMocks();
  });

  it('is undefined before the clock is started', () => {
    // A daemon that never marked the clock cannot report a wait, and must not report zero: zero is a
    // measurement, and this is the absence of one.
    expect(stallUptime(10_000)).toBeUndefined();
  });

  it('reports how long the daemon has waited with nothing connected', () => {
    markStallClock(1_000);
    expect(stallUptime(11_000)).toBe(10_000);
  });

  it('goes quiet once an app connects, so a slow start is not a stall', () => {
    // The distinction the whole thing turns on. A run that takes a while and then works has nothing
    // worth telling anybody about, and saying otherwise would train people to ignore the warning.
    markStallClock(1_000);
    vi.spyOn(appInstrumented, 'appEverConnected').mockReturnValue(true);
    expect(stallUptime(STALL_AFTER_MS * 2)).toBeUndefined();
  });
});
