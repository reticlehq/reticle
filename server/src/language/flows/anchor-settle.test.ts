/**
 * A replayed step waits for its anchor on a fixed 150ms grid, eight times over.
 *
 * Measured on next-app-router with RETICLE_TRACE: one `flow.step` span was 1079ms containing nine
 * QUERY round-trips of 1–2ms each — the whole cost is the sleeping between them, and four such steps
 * were 4.3s of that app's 7.6s. A mounting element IS a DOM mutation, and the session already
 * streams those, so waiting out a fixed tick after the thing has happened is pure latency.
 *
 * The change can only make the loop find an anchor SOONER. It never concludes absence earlier: the
 * attempt budget is untouched, so a genuinely missing anchor still costs the full settle before it
 * drifts. That asymmetry is the whole safety argument — an early "not found" would be a false drift,
 * which is the one thing this loop exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { resolveQuery } from './flow-replay.js';
import type { FlowReplaySession } from './flow-replay.js';
import type { ReticleEvent, CommandResult } from '@reticlehq/core';

/** A session whose QUERY starts empty and starts matching only after `appearAfter` calls. */
function sessionThatMountsAfter(appearAfter: number): {
  session: FlowReplaySession;
  fire: () => void;
  queries: () => number;
} {
  let queries = 0;
  const listeners = new Set<(e: ReticleEvent) => void>();
  const session: FlowReplaySession = {
    command: (): Promise<CommandResult> => {
      queries += 1;
      const refs = queries > appearAfter ? [{ ref: 'e1' }] : [];
      return Promise.resolve({
        kind: 'command_result',
        id: 'x',
        ok: true,
        result: { elements: refs },
      } as unknown as CommandResult);
    },
    eventsSince: () => [],
    onEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    elapsed: () => 0,
  };
  return {
    session,
    fire: () => {
      for (const l of listeners) l({} as ReticleEvent);
    },
    queries: () => queries,
  };
}

describe('resolveQuery — a DOM event ends the wait early', () => {
  it('re-queries as soon as the page mutates, instead of finishing the tick', async () => {
    const { session, fire, queries } = sessionThatMountsAfter(1);
    let slept = 0;
    // A sleep that never resolves on its own: if the event path did not work, this test would hang
    // rather than quietly pass on the timer. The wait must be ended by the event or not at all.
    const sleep = (): Promise<void> =>
      new Promise(() => {
        slept += 1;
      });
    const pending = resolveQuery(session, { by: 'testid', value: 'x' }, sleep);
    // Let the first query settle, then mutate the page.
    await Promise.resolve();
    await Promise.resolve();
    fire();
    const result = await pending;
    expect(result.refs).toEqual(['e1']);
    expect(queries()).toBe(2);
    expect(slept, 'it did wait — it just did not wait it out').toBeGreaterThan(0);
  });

  /**
   * The safety half. With no events at all the loop must still spend its whole budget before
   * reporting an empty result, because "absent" is a verdict a flow drifts on.
   */
  it('still spends the full budget when nothing ever happens', async () => {
    const { session, queries } = sessionThatMountsAfter(Number.MAX_SAFE_INTEGER);
    // The clock is injected and the sleep advances it, because that is what a real 150ms sleep does.
    // The budget is now wall-clock rather than attempt-counted, so a no-op sleep against a frozen
    // clock would describe a page that waits for free — which is not a page.
    let clock = 0;
    const sleep = (ms: number): Promise<void> => {
      clock += ms;
      return Promise.resolve();
    };
    const result = await resolveQuery(session, { by: 'testid', value: 'x' }, sleep, () => clock);
    expect(result.refs).toEqual([]);
    // Nine, not the old eight. `attempt < 8` starting at 1 gave SEVEN retries — 1050ms, not the
    // ~1.2s the docblock claimed. The wall-clock bound delivers the budget that was always written
    // down; the attempt count had been quietly under-spending it by a tick.
    expect(queries(), 'one initial query plus a full 1200ms of retries at 150ms each').toBe(9);
    expect(clock, 'and it spent exactly the documented budget').toBe(1200);
  });
});

/**
 * The other half of the same trade, and the one that was wrong.
 *
 * Reported from the field, diagnosed precisely:
 *
 * > `ANCHOR_SETTLE_ATTEMPTS=8, ANCHOR_SETTLE_DELAY_MS=150`, intended ~1.2s. But settleTick resolves
 * > on EITHER `session.onEvent` OR the 150ms sleep, whichever fires first. On a page emitting
 * > continuous events (4 API calls + large form render + CSS transition anim.start/anim.end pairs),
 * > all 8 attempts are consumed by incoming events in **224–758ms observed**, well before a newly
 * > routed page mounts its controls.
 *
 * The early-return above is right; counting an event-driven tick against the ATTEMPT budget is not.
 * An event arriving is evidence the page is still working, so it should extend the wait, not spend
 * it. The result was that cross-route replays drifted `testid_not_found` at 278ms on a budget
 * documented as 1.2s, while the identical flow passed on a quiet page.
 *
 * So the governing bound becomes WALL-CLOCK. The attempt cap survives only as a backstop against a
 * pathological event storm spinning the loop; it is no longer what decides when to give up.
 *
 * Note what is asserted: the number of QUERY calls and the fact of termination — never an elapsed
 * duration. Per CLAUDE.md, if the property is "the cost is bounded", assert the bound. The clock is
 * injected, so this is deterministic and instant.
 */
describe('resolveQuery — an event extends the wait, it does not spend the budget', () => {
  /** A page that never stops emitting: every tick is ended by an event, never by the sleep. */
  function chattySession(appearAfter: number): {
    session: FlowReplaySession;
    queries: () => number;
  } {
    let queries = 0;
    let onEvt: ((e: ReticleEvent) => void) | undefined;
    const session: FlowReplaySession = {
      command: (): Promise<CommandResult> => {
        queries += 1;
        const refs = queries > appearAfter ? [{ ref: 'e1' }] : [];
        // The page is busy: something fires the moment anyone starts listening.
        queueMicrotask(() => onEvt?.({} as ReticleEvent));
        return Promise.resolve({
          kind: 'command_result',
          id: 'x',
          ok: true,
          result: { elements: refs },
        } as unknown as CommandResult);
      },
      eventsSince: () => [],
      onEvent: (l) => {
        onEvt = l;
        return () => {
          onEvt = undefined;
        };
      },
      elapsed: () => 0,
    };
    return { session, queries: () => queries };
  }

  it('keeps looking past 8 attempts while the clock says there is budget left', async () => {
    // Mounts late — after more attempts than the old cap allowed.
    const { session, queries } = chattySession(12);
    // The clock never moves, because on a chatty page it barely does: every tick is ended by an
    // event within a millisecond or two, not by the 150ms sleep. That is the whole reported bug —
    // 8 attempts consumed in 224ms — so a frozen clock is the faithful model of it.
    const FROZEN = 0;
    const sleep = (): Promise<void> => Promise.resolve();
    const result = await resolveQuery(session, { by: 'testid', value: 'x' }, sleep, () => FROZEN);

    expect(
      result.refs,
      'gave up before the anchor mounted — the attempt budget was spent by events, not by waiting',
    ).toEqual(['e1']);
    expect(queries(), 'the old cap stopped at 8 queries').toBeGreaterThan(8);
  });

  it('still terminates when the clock runs out, even if events never stop', async () => {
    const { session, queries } = chattySession(Number.MAX_SAFE_INTEGER);
    let clock = 0;
    // Each tick advances the injected clock, so the wall-clock budget is what ends this.
    const sleep = (): Promise<void> => {
      clock += 150;
      return Promise.resolve();
    };
    const result = await resolveQuery(session, { by: 'testid', value: 'x' }, sleep, () => clock);

    expect(result.refs).toEqual([]);
    expect(queries(), 'it must stop — a runaway loop is worse than a false drift').toBeLessThan(50);
  });
});
