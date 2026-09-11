/**
 * Four things the telemetry could not answer, closed.
 *
 * All four are PROPERTIES on events that already exist — no new event kinds, which is the whole
 * point: the vocabulary was never too large, one event was firing for something it did not measure.
 *
 * 1. NO-SESSION ERRORS AS A FIRST-CLASS NUMBER.
 *    74% of daemons never call a tool, and of the 13 single-call sessions in one real day, 10
 *    bounced on "no browser session connected". The fact IS in the data — `session_errors[]`
 *    fingerprints it — but only inside a nested array in the fat block, so no point-and-click tile
 *    can reach the biggest drop-off in the funnel.
 *
 * 2. RETRY LOOPS VS USEFUL CALLS.
 *    `toolCounts` cannot tell five useful calls from five retries of one failing call, and those are
 *    opposite facts: engagement versus an agent stuck in a loop.
 *
 * 3. ABANDONMENT.
 *    An action driven with no verdict after it is the signature of the loop breaking mid-task.
 *
 * 4. LOCAL TIME OF DAY.
 *    Every "when do they work" tile depends on ingest-side GeoIP. An offset is one number and
 *    identifies nobody.
 */

import { describe, expect, it } from 'vitest';
import { SessionMetrics } from './session-metrics.js';

const NO_SESSION =
  'no browser session connected. Two things to check: (1) your app is running with @reticlehq/browser enabled';

describe('the funnel-killer is countable without unpacking an array', () => {
  it('counts tool errors that mean "nothing was connected"', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolError(NO_SESSION, 'reticle_snapshot');
    m.recordToolError('no connected session with id s123', 'reticle_act');
    m.recordToolError(
      'multiple sessions connected — pass sessionId to target one: s1, s2',
      'reticle_query',
    );
    m.recordToolError('command timed out after 5000ms', 'reticle_act');
    const s = m.summarize(true);
    // The first three are all "the agent could not reach an app"; the timeout is a different failure.
    expect(s.noSessionErrors).toBe(3);
    expect(s.toolErrors).toBe(4);
  });

  it('is absent rather than zero when it never happened, so its PRESENCE is the signal', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolError('command timed out after 5000ms', 'reticle_act');
    expect(m.summarize(true).noSessionErrors).toBeUndefined();
  });
});

describe('a retry loop does not look like engagement', () => {
  it('records the longest run of the SAME tool called back to back', () => {
    const m = new SessionMetrics(() => 0);
    for (const t of [
      'reticle_query',
      'reticle_act',
      'reticle_act',
      'reticle_act',
      'reticle_snapshot',
    ]) {
      m.recordToolCall(t);
    }
    expect(m.summarize(true).consecutiveRepeats).toEqual({ reticle_act: 3 });
  });

  it('does not report a tool that was never repeated — five different calls are five calls', () => {
    const m = new SessionMetrics(() => 0);
    for (const t of ['a', 'b', 'c', 'd', 'e']) m.recordToolCall(t);
    expect(m.summarize(true).consecutiveRepeats).toBeUndefined();
  });

  it('an interleaved call breaks the run, because that is not a retry loop', () => {
    const m = new SessionMetrics(() => 0);
    for (const t of ['x', 'y', 'x', 'y', 'x']) m.recordToolCall(t);
    expect(m.summarize(true).consecutiveRepeats).toBeUndefined();
  });
});

describe('an action with no verdict AFTER it is abandonment', () => {
  /**
   * The first version of this subtracted totals: `actions - verifications`. That is not what the
   * field claims to measure and it is wrong in both directions, because it ignores ORDER.
   *
   * A verdict settles whatever was outstanding when it arrives; what is abandoned is the run of
   * actions after the LAST one. So the measure is the trailing unsettled run, not a difference.
   */
  it('counts the actions left hanging after the last verdict', () => {
    const m = new SessionMetrics(() => 0);
    m.recordAction();
    m.recordVerification(); // settles it
    m.recordAction();
    m.recordAction(); // ...and then the loop stops
    expect(m.summarize(true).abandonedActions).toBe(2);
  });

  it('a verdict settles everything outstanding, however many actions it took', () => {
    const m = new SessionMetrics(() => 0);
    m.recordAction();
    m.recordAction();
    m.recordAction();
    m.recordVerification();
    expect(m.summarize(true).abandonedActions).toBeUndefined();
  });

  it('a verification with NO action before it cannot cancel a later abandonment', () => {
    // The bug the subtraction had: a flow_verify is a verdict that drove nothing, so under
    // `actions - verifications` it silently paid for a genuinely abandoned action elsewhere.
    const m = new SessionMetrics(() => 0);
    m.recordVerification(); // e.g. reticle_flow_verify — a verdict, but it acted on nothing
    m.recordAction(); // ...then the agent drove the page and never checked
    expect(m.summarize(true).abandonedActions, 'the flow_verify must not mask this').toBe(1);
  });

  it('a loop that always ends in a verdict abandons nothing', () => {
    const m = new SessionMetrics(() => 0);
    m.recordAction();
    m.recordVerification();
    expect(m.summarize(true).abandonedActions).toBeUndefined();
  });
});
