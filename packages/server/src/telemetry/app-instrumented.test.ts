/**
 * The funnel step must be counted once per install attempt, not once per page load.
 *
 * The field this replaces was a per-window counter, so it reset on every flush and read zero for
 * users who had demonstrably instrumented an app. The replacement is only useful if it holds the
 * opposite property: exactly one event per daemon run, whatever the page does afterwards. A page
 * that reloads, an app that opens five tabs, or a dev server restarting mid-session must not each
 * read as another install getting wired.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { TelemetryEventKind } from '@reticlehq/core/telemetry';
import {
  reportAppInstrumented,
  markInstrumentationClock,
  resetAppInstrumented,
} from './app-instrumented.js';

/** Typed, so `mock.calls` is a real tuple rather than `[]` under the build's stricter settings. */
const emit = vi.fn<(kind: string, extra?: TelemetryExtraLike) => Promise<boolean>>(() =>
  Promise.resolve(true),
);

interface TelemetryExtraLike {
  instrumentation: Record<string, unknown>;
}
vi.mock('./telemetry.js', () => ({ getTelemetry: () => ({ emit, enabled: true }) }));

beforeEach(() => {
  emit.mockClear();
  resetAppInstrumented();
});

const facts = { initialized: true, agentAttached: true };

describe('app_instrumented', () => {
  it('fires on the first app to connect', () => {
    markInstrumentationClock(1_000);
    reportAppInstrumented(facts, () => 4_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toBe(TelemetryEventKind.APP_INSTRUMENTED);
  });

  it('fires exactly once no matter how many sessions follow', () => {
    markInstrumentationClock(1_000);
    for (let i = 0; i < 5; i += 1) reportAppInstrumented(facts, () => 2_000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('arms again for the next daemon run', () => {
    markInstrumentationClock(1_000);
    reportAppInstrumented(facts, () => 2_000);
    markInstrumentationClock(9_000);
    reportAppInstrumented(facts, () => 9_500);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('reports how long the daemon sat with nothing wired', () => {
    markInstrumentationClock(1_000);
    reportAppInstrumented(facts, () => 61_000);
    expect(emit.mock.calls[0]?.[1]?.instrumentation['msToFirstApp']).toBe(60_000);
  });

  it('never reports a negative age when the clock moves backwards', () => {
    markInstrumentationClock(10_000);
    reportAppInstrumented(facts, () => 1_000);
    expect(emit.mock.calls[0]?.[1]?.instrumentation['msToFirstApp']).toBe(0);
  });

  it('carries both halves of the install and nothing about the page', () => {
    markInstrumentationClock(0);
    reportAppInstrumented({ initialized: false, agentAttached: true }, () => 500);
    const extra = emit.mock.calls[0]?.[1]?.instrumentation ?? {};
    expect(extra['initialized']).toBe(false);
    expect(extra['agentAttached']).toBe(true);
    // Names, never values: no url, no path, no project identity of any kind.
    expect(Object.keys(extra).sort()).toEqual(['agentAttached', 'initialized', 'msToFirstApp']);
  });

  it('a telemetry failure never propagates to the connecting page', () => {
    emit.mockImplementationOnce(() => {
      throw new Error('network down');
    });
    markInstrumentationClock(0);
    expect(() => reportAppInstrumented(facts, () => 1)).not.toThrow();
  });
});
