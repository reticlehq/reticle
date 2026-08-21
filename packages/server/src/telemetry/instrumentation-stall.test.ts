/**
 * The event that exists to explain the funnel's biggest silence could barely fire.
 *
 * `reportInstrumentationStall` was only ever called from the session flush interval, and it refuses
 * to report until `STALL_AFTER_MS` (10 minutes) has passed with no app. But an UNATTENDED daemon
 * shuts itself down after `DAEMON_IDLE_SHUTDOWN_MS` (5 minutes) — it is gone before it is allowed to
 * say anything. Only an ATTACHED daemon gets the six-times grace that lets it reach ten minutes.
 *
 * So `agentAttached` was forced to `true` on essentially every row, and the one bucket the event was
 * built to measure — installed it, walked away, never wired the app — was structurally unobservable.
 * That is the same defect the outage metric had: a property with one degree of freedom, on an event
 * that reads as working because rows keep arriving.
 *
 * Telemetry fails silently, so there is no test that could have gone red. Hence these.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelemetryEventKind } from '@reticlehq/core';
import {
  STALL_AFTER_MS,
  markStallClock,
  reportInstrumentationStall,
  resetInstrumentationStall,
  stallUptime,
} from './instrumentation-stall.js';
import * as telemetry from './telemetry.js';
import * as appInstrumented from './app-instrumented.js';

interface Sent {
  kind: TelemetryEventKind;
  stall?: { initialized: boolean; agentAttached: boolean; msWaited: number };
}

function captureEmits(): Sent[] {
  const sent: Sent[] = [];
  vi.spyOn(telemetry, 'getTelemetry').mockReturnValue({
    emit: (kind, extra) => {
      sent.push({ kind, ...(extra?.stall === undefined ? {} : { stall: extra.stall }) });
      return Promise.resolve(true);
    },
    enabled: true,
    firstRun: false,
  });
  return sent;
}

/** No app ever connected — the precondition for every case here. */
function noAppEverConnected(): void {
  vi.spyOn(appInstrumented, 'appEverConnected').mockReturnValue(false);
}

const FACTS = { initialized: true, agentAttached: false };

afterEach(() => {
  vi.restoreAllMocks();
  resetInstrumentationStall();
});

describe('instrumentation_stalled on the periodic path', () => {
  it('says nothing before the threshold', () => {
    const sent = captureEmits();
    noAppEverConnected();
    markStallClock(0);
    expect(reportInstrumentationStall(FACTS, () => STALL_AFTER_MS - 1)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('reports once past the threshold, and only once', () => {
    const sent = captureEmits();
    noAppEverConnected();
    markStallClock(0);
    expect(reportInstrumentationStall(FACTS, () => STALL_AFTER_MS + 1)).toBe(true);
    expect(reportInstrumentationStall(FACTS, () => STALL_AFTER_MS * 2)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe(TelemetryEventKind.INSTRUMENTATION_STALLED);
  });

  it('says nothing once an app has connected', () => {
    const sent = captureEmits();
    vi.spyOn(appInstrumented, 'appEverConnected').mockReturnValue(true);
    markStallClock(0);
    expect(reportInstrumentationStall(FACTS, () => STALL_AFTER_MS * 10)).toBe(false);
    expect(sent).toEqual([]);
  });
});

/**
 * The fix. A daemon that is EXITING and never saw an app has stalled — that is a fact, not an
 * inference, and it does not become more true at ten minutes than at five. The threshold exists to
 * stop a daemon crying stall seconds after boot; at shutdown there is nothing left to wait for.
 *
 * `msWaited` still carries the duration, so anyone who wants to exclude short runs can, on the data,
 * rather than being unable to see them at all.
 */
describe('instrumentation_stalled on the shutdown path', () => {
  it('reports an unattended daemon that exits before the periodic threshold', () => {
    const sent = captureEmits();
    noAppEverConnected();
    markStallClock(0);
    // The unattended idle exit, which lands well short of STALL_AFTER_MS.
    const exitAt = 5 * 60 * 1000;
    expect(exitAt).toBeLessThan(STALL_AFTER_MS);

    expect(
      reportInstrumentationStall(FACTS, () => exitAt),
      'periodic path stays quiet',
    ).toBe(false);
    expect(
      reportInstrumentationStall(FACTS, () => exitAt, { atShutdown: true }),
      'the shutdown path must not be gated on the threshold',
    ).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.stall).toEqual({ initialized: true, agentAttached: false, msWaited: exitAt });
  });

  it('lets agentAttached be false, which the periodic path alone could never record', () => {
    const sent = captureEmits();
    noAppEverConnected();
    markStallClock(0);
    reportInstrumentationStall({ initialized: false, agentAttached: false }, () => 1000, {
      atShutdown: true,
    });
    expect(sent[0]?.stall?.agentAttached).toBe(false);
    expect(sent[0]?.stall?.initialized).toBe(false);
  });

  it('does not double-report when the periodic path already did', () => {
    const sent = captureEmits();
    noAppEverConnected();
    markStallClock(0);
    reportInstrumentationStall(FACTS, () => STALL_AFTER_MS + 1);
    reportInstrumentationStall(FACTS, () => STALL_AFTER_MS + 2, { atShutdown: true });
    expect(sent).toHaveLength(1);
  });

  it('still says nothing when an app connected, however the daemon ends', () => {
    const sent = captureEmits();
    vi.spyOn(appInstrumented, 'appEverConnected').mockReturnValue(true);
    markStallClock(0);
    expect(reportInstrumentationStall(FACTS, () => 1000, { atShutdown: true })).toBe(false);
    expect(sent).toEqual([]);
  });

  it('says nothing when the clock was never started', () => {
    const sent = captureEmits();
    noAppEverConnected();
    expect(reportInstrumentationStall(FACTS, () => 1000, { atShutdown: true })).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('stallUptime — how long a daemon has waited with no app', () => {
  it('returns the elapsed time when no app has connected', () => {
    noAppEverConnected();
    markStallClock(1000);
    expect(stallUptime(11_000)).toBe(10_000);
  });

  it('returns undefined once an app has connected', () => {
    vi.spyOn(appInstrumented, 'appEverConnected').mockReturnValue(true);
    markStallClock(0);
    expect(stallUptime(STALL_AFTER_MS * 2)).toBeUndefined();
  });

  it('returns undefined when the clock was never started', () => {
    noAppEverConnected();
    expect(stallUptime(99_999)).toBeUndefined();
  });
});
