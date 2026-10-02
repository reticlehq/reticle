/**
 * A navigation has to move the verdict floor, because it destroys the document.
 *
 * Reported from the field, and the report is worth stating in full because the shape is instructive.
 * An agent reloaded the page, restarted its API server, and then asserted four strings that were
 * genuinely on the screen. Every clause passed — and the verdict came back `verified: "no"`,
 * `contradicted`, blaming "684 request(s) in the same window failed", every one of them a 500 against
 * a resource that no longer existed. The reporter proved they were not live three separate ways: the
 * app's own log recorded no 5xx since the restart, one of the URLs named a database row that does not
 * exist, and the failures predated a hard reload.
 *
 * The mechanism: `reticle_assert` defaults its window to `args.since ?? lastAct.cursor() ?? 0`, and
 * the cursor is set ONLY by act, act_sequence and act_and_wait. Navigating — by URL or by reload —
 * did not move it. So an agent that reloads and then asserts judges over the whole session, and
 * `queryEvents` is journal-backed, so "the whole session" is durable history that outlives the
 * document. Failures from a page that no longer exists then contradict an assertion about the page
 * that does.
 *
 * Kept as a floor rather than as a filter on the contradiction rules: the window is the one place
 * this can be fixed once for every rule that reads it, and a rule-by-rule fix would leave the next
 * rule to rediscover it.
 */

import { describe, expect, it } from 'vitest';
import { LastAct } from './last-act.js';

describe('the verdict floor', () => {
  it('is unset before anything has happened, so callers fall back deliberately', () => {
    expect(new LastAct().cursor()).toBeUndefined();
  });

  it('moves to an act', () => {
    const last = new LastAct();
    last.markActed(100, 'click', 3);
    expect(last.cursor()).toBe(100);
  });

  it('moves to a NAVIGATION, which is the case the field report hit', () => {
    const last = new LastAct();
    last.markNavigated(250);
    expect(last.cursor()).toBe(250);
  });

  /**
   * The ordering that matters. An act, then a reload: everything the act produced belongs to a
   * document that is gone, so the floor has to be the reload and not the act.
   */
  it('takes the most recent of the two, not whichever was written last by type', () => {
    const last = new LastAct();
    last.markActed(100, 'click', 3);
    last.markNavigated(250);
    expect(last.cursor(), 'a reload after an act moves the floor forward').toBe(250);

    const other = new LastAct();
    other.markNavigated(250);
    other.markActed(400, 'click', 1);
    expect(other.cursor(), 'and an act after a reload moves it forward again').toBe(400);
  });

  it('never moves backwards', () => {
    const last = new LastAct();
    last.markActed(400, 'click', 1);
    last.markNavigated(250);
    expect(last.cursor(), 'an older navigation cannot lower a newer act floor').toBe(400);
  });

  /**
   * A navigation is not an act, and must not be reported as one. The "this click did nothing" check
   * reads `effect()` — an action with no measured mutation — so recording a navigation there would
   * have it accuse a reload of being a dead click.
   */
  it('records no act EFFECT for a navigation', () => {
    const last = new LastAct();
    last.markNavigated(250);
    expect(last.effect()).toEqual({});
  });

  it('leaves an act effect alone when a navigation follows it', () => {
    const last = new LastAct();
    last.markActed(100, 'click', 3);
    last.markNavigated(250);
    expect(last.effect()).toEqual({ action: 'click', mutatedWithin: 3 });
  });
});
