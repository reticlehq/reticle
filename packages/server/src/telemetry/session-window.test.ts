/**
 * Three defects in the session-summary path, all measured against the exported PostHog data
 * (`plan/export-2026-08-07-205221.csv`, 1,468 events, one day).
 *
 * 1. AN EVENT NAMED `daemon_stopped` IS EMITTED WHILE THE DAEMON IS RUNNING.
 *    The 30-minute periodic flush emits `DAEMON_STOPPED` with `final: false`. In the export, 98
 *    `daemon_stopped` events are 73 real exits + 25 mid-session flushes. Counting them as sessions
 *    over-states by 34%, and the two populations are OPPOSITES: every one of the 25 flushes had
 *    tool calls, and not one of the 73 exits did. Any funnel drawn over the raw event is not
 *    slightly off, it is describing a different thing at each end. (Our own funnel analysis made
 *    exactly this mistake.)
 *
 * 2. `#seenBugKinds` IS CLEARED BY THE FLUSH.
 *    It is not a window counter — it is the session-lifetime memory that decides `repeat` on
 *    `bug_found`. Clearing it every 30 minutes makes the same defect, found again, report as a new
 *    distinct one. Sessions in the export run to 11.5 hours, i.e. 23 chances to double-count.
 *
 * 3. THE LAST WINDOW OF AN ACTIVE DAEMON IS NEVER REPORTED.
 *    A daemon that served a tool never idle-exits (correctly — it is doing a job), and nothing else
 *    calls shutdown, so its final partial window dies with the process. Measured: 0 of 73 final
 *    summaries carry a single tool call; all 400 tool calls, 13 bugs and 2 verifications in the
 *    dataset arrived via flushes. The unreported tail is bounded by the flush interval, which is why
 *    a 30-minute interval is the wrong bound for a median 28-minute session.
 */

import { describe, expect, it } from 'vitest';
import { TelemetryEventKind } from '@reticlehq/core/telemetry';
import { SessionMetrics } from './session-metrics.js';
import { FIRST_FLUSH_MS, SESSION_FLUSH_MS } from './daemon-telemetry.js';

describe('a mid-session flush is not a session end', () => {
  it('has its own event kind', () => {
    expect(TelemetryEventKind.SESSION_PROGRESS).toBeDefined();
    expect(TelemetryEventKind.SESSION_PROGRESS).not.toBe(TelemetryEventKind.DAEMON_STOPPED);
  });
});

describe('the flush must not forget which defects it has already reported', () => {
  it('a bug kind seen before the flush is still a repeat after it', () => {
    const m = new SessionMetrics(() => 0);
    expect(m.recordBug('missing-testid'), 'first sighting').toBe(true);
    m.reset(); // the 30-minute flush
    expect(
      m.recordBug('missing-testid'),
      'same defect, same session — reporting it as newly distinct inflates the count',
    ).toBe(false);
  });

  it('but the window COUNTERS do still zero, or every flush would restate the total', () => {
    const m = new SessionMetrics(() => 0);
    m.recordBug('a');
    m.reset();
    // `summarize(false)` IS the flush. This assertion used to pass `true` — the FINAL summary, which
    // is not a flush and never was — so it read as pinning window semantics while actually pinning
    // the defect in item 3 above: the end-of-session event describing only the residue after the
    // last tick. Same intent, now asserted on the call the intent is about.
    expect(m.summarize(false).bugsFound, 'a flush reports its own window').toBe(0);
    expect(
      m.summarize(true).bugsFound,
      'the FINAL event reports the session — item 3 of this file, finally fixed',
    ).toBe(1);
  });
});

describe('the unreported tail is bounded by the flush interval', () => {
  it('is short enough to survive a median session', () => {
    // Median session in the export is 28 minutes. A 30-minute interval means the median session
    // reports nothing at all until it is nearly over, and loses whatever came after its last tick.
    expect(SESSION_FLUSH_MS).toBeLessThanOrEqual(5 * 60 * 1000);
  });
});

/**
 * A session killed before the first periodic tick must not vanish.
 *
 * The interval alone leaves a hole exactly its own width: a daemon SIGKILLed before it fires — a
 * closed laptop, OOM, `kill -9`, a force-quit editor — reaches no shutdown handler and has emitted
 * nothing, so the entire session is invisible.
 *
 * In the field `daemon_started` outran `daemon_stopped` by a wide margin: **a meaningful share of
 * sessions never reported a summary at all.** Every "did anyone use Reticle" figure is computed only
 * on the survivors and undercounts by an unknown amount.
 */
describe('the first roll-up does not wait for the periodic interval', () => {
  it('fires well before the periodic flush', () => {
    expect(FIRST_FLUSH_MS).toBeLessThan(SESSION_FLUSH_MS);
  });

  it('is short enough to catch a session that does its work up front', () => {
    // snapshot -> act -> assert is seconds. Anything above ~2 minutes stops protecting the sessions
    // this exists for.
    expect(FIRST_FLUSH_MS).toBeLessThanOrEqual(120_000);
  });

  it('is not so short that it splits a normal drive into noise', () => {
    expect(FIRST_FLUSH_MS).toBeGreaterThanOrEqual(30_000);
  });
});
