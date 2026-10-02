/**
 * Three defects in the session-summary path.
 *
 * 1. AN EVENT NAMED `daemon_stopped` IS EMITTED WHILE THE DAEMON IS RUNNING.
 *    The periodic flush emits `DAEMON_STOPPED` with `final: false`, so the raw event mixes real
 *    exits with mid-session flushes. Counting them as sessions over-states, and the two populations
 *    are OPPOSITES — a flush happens because a tool was called, an idle exit happens because none
 *    was. Anything drawn over the raw event describes a different thing at each end.
 *
 * 2. `#seenBugKinds` IS CLEARED BY THE FLUSH.
 *    It is not a window counter — it is the session-lifetime memory that decides `repeat` on
 *    `bug_found`. Clearing it on every flush makes the same defect, found again, report as a new
 *    distinct one, once per flush for the life of the session.
 *
 * 3. THE LAST WINDOW OF AN ACTIVE DAEMON IS NEVER REPORTED.
 *    A daemon that served a tool never idle-exits (correctly — it is doing a job), and nothing else
 *    calls shutdown, so its final partial window dies with the process. Every tool call therefore
 *    has to arrive by flush, and the unreported tail is bounded by the flush interval.
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
    // An interval on the order of a whole session means the typical session reports nothing at all
    // until it is nearly over, and loses whatever came after its last tick.
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
 * A session that never reports a summary is invisible, so every figure computed over the survivors
 * undercounts by an unknown amount.
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
