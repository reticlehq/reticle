/**
 * The other navigation shape (#2009), covered by `followLostObservation`'s second phase.
 *
 * An app whose sign-in backend answers slowly moves the page AFTER the act budget has expired: the
 * wait graded the route on the document BEFORE it left ("current route '/login', expected
 * '/today'"), the page re-announced on /today a second later, and the agent read a failure for a
 * sign-in that worked. Phase 2 is gated on EVIDENCE ALREADY IN THE WINDOW at grading time — the
 * departure observer records the leaving as a NET_PENDING at dispatch, so a form POST that answers
 * late still has its departure in the buffer. Evidence present: the grace (8s) bounds a successor
 * wait, the re-ask runs there, and the extension is declared as budgetExtendedMs. Evidence absent:
 * the failure returns UNCHANGED and AT ONCE — the clock is never advanced, not by a poll and not by
 * the grace. A navigation that started but whose successor never connects gives the explicit "page
 * left its document" lost verdict.
 */
import { describe, expect, it } from 'vitest';
import { EventType, NetInitiator } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';
import { followLostObservation, NAVIGATION_FOLLOW_GRACE_MS } from './act-observation.js';
import type { Session } from '@/portal/session/session.js';
import type { EvalResult } from '@reticlehq/engine/question/predicate/predicate-eval.js';

const failed = (): EvalResult => ({
  pass: false,
  failureReason: "current route '/login', expected '/today'",
});
const passed = (): EvalResult => ({ pass: true });

const DEPARTURE: ReticleEvent = {
  t: 10,
  type: EventType.NET_PENDING,
  sessionId: 'a',
  data: {
    id: 'nav-1',
    method: 'POST',
    url: 'http://app.test/signin',
    initiator: NetInitiator.NAVIGATION,
  },
};

const fakeSession = (
  id: string,
  url: string,
  events: ReticleEvent[] = [],
  opts: { staleMs?: number; agentIdleMs?: number; elapsed?: number } = {},
): Session =>
  ({
    id,
    url,
    staleMs: () => opts.staleMs ?? 1_000,
    agentIdleMs: () => opts.agentIdleMs ?? 500,
    elapsed: () => opts.elapsed ?? 0,
    command: () => Promise.reject(new Error('fake')),
    eventsSince: () => events,
    onEvent: () => () => undefined,
    pushEvent: (_event: unknown) => undefined,
  }) as unknown as Session;

/**
 * A clock that RECORDS what phase 2 does to it: every sleep's milliseconds and every now() call.
 * The author's test-a assertion reads the recorded milliseconds — a no-navigation failure must
 * leave the total at exactly 0.
 */
const recordingClock = () => {
  const state = { sleptMs: 0, nowCalls: 0, tick: 0 };
  return {
    state,
    // now() advances 1s per call, so every deadline in the code under test is eventually reached.
    now: () => {
      state.nowCalls += 1;
      return state.nowCalls * 1_000;
    },
    sleep: (ms: number) => {
      state.sleptMs += ms;
      return Promise.resolve();
    },
  };
};
const registry = (sessions: Session[]) => ({
  get: (id: string) => sessions.find((s) => s.id === id),
  all: () => sessions,
});

const LOGIN = 'http://app.test/login?__reticle_session=lease-1';
const TODAY = 'http://app.test/today';

describe('phase 2 — gated on departure evidence already in the window', () => {
  it('follows the successor and re-asks there when the departure was recorded', async () => {
    // The real successor claims the lease marker: the pool's init script re-stamps it on the
    // redirected document (#1381). A claimless successor is refused by mayInherit — correctly,
    // since an unclaimed tab at the origin might be somebody else's tab entirely.
    const successor = fakeSession('b', `${TODAY}?__reticle_session=lease-1`, [], {
      staleMs: 100,
      agentIdleMs: 500,
    });
    const out = await followLostObservation({
      sessions: registry([successor]),
      session: fakeSession('a', LOGIN, [DEPARTURE]),
      verdict: failed(),
      since: 0,
      timeout: 5_000,
      predicateStarted: 0,
      failedFollowGraceMs: NAVIGATION_FOLLOW_GRACE_MS,
      reevaluate: (s, budget) => {
        expect(s.id).toBe('b');
        expect(budget).toBe(NAVIGATION_FOLLOW_GRACE_MS);
        return Promise.resolve(passed());
      },
      clock: recordingClock(),
    });

    expect(out.followed).toBe(true);
    expect(out.session.id).toBe('b');
    expect(out.verdict.pass).toBe(true);
    expect(out.budgetExtendedMs).toBe(NAVIGATION_FOLLOW_GRACE_MS);
  });

  it('answers with the navigation itself when the document leaves and no successor connects', async () => {
    // The disconnect removes the departed from the registry and no successor ever connects: the
    // document left, so the verdict says exactly that instead of standing as a product failure.
    const out = await followLostObservation({
      sessions: registry([]),
      session: fakeSession('a', LOGIN, [DEPARTURE]),
      verdict: failed(),
      since: 0,
      timeout: 5_000,
      predicateStarted: 0,
      failedFollowGraceMs: NAVIGATION_FOLLOW_GRACE_MS,
      reevaluate: () => Promise.resolve(passed()),
      clock: recordingClock(),
    });

    expect(out.followed).toBe(false);
    expect(out.verdict.pass).toBe(false);
    expect(out.verdict.observationLost).toBe(true);
    expect(out.verdict.failureReason).toContain('left its document');
    expect(out.verdict.failureReason).toContain('no successor session connected');
  });

  it('returns a no-navigation failure AT ONCE — zero slept milliseconds, the grace untouched', async () => {
    // No NET_PENDING in the window: the document never moved, so there is nothing to wait for.
    // The author's assertion: the total milliseconds handed to clock.sleep is exactly 0.
    const clock = recordingClock();
    const verdict = failed();
    const session = fakeSession('a', LOGIN, []);
    const out = await followLostObservation({
      sessions: registry([session]),
      session,
      verdict,
      since: 0,
      timeout: 5_000,
      predicateStarted: 0,
      failedFollowGraceMs: NAVIGATION_FOLLOW_GRACE_MS,
      reevaluate: () => Promise.resolve(passed()),
      clock,
    });

    expect(out.followed).toBe(false);
    expect(out.verdict).toBe(verdict);
    expect(clock.state.sleptMs).toBe(0);
  });

  it('leaves a PASS alone — only failures can be a graded-on-a-leaving-document mistake', async () => {
    const verdict = passed();
    const out = await followLostObservation({
      sessions: registry([fakeSession('a', LOGIN, [DEPARTURE])]),
      session: fakeSession('a', LOGIN, [DEPARTURE]),
      verdict,
      since: 0,
      timeout: 5_000,
      predicateStarted: 0,
      failedFollowGraceMs: NAVIGATION_FOLLOW_GRACE_MS,
      reevaluate: () => Promise.resolve(passed()),
      clock: recordingClock(),
    });

    expect(out.followed).toBe(false);
    expect(out.verdict).toBe(verdict);
  });

  it('keeps the old behaviour when the caller grants no grace', async () => {
    const out = await followLostObservation({
      sessions: registry([fakeSession('a', LOGIN, [DEPARTURE])]),
      session: fakeSession('a', LOGIN, [DEPARTURE]),
      verdict: failed(),
      since: 0,
      timeout: 5_000,
      predicateStarted: 0,
      reevaluate: () => Promise.resolve(passed()),
      clock: recordingClock(),
    });

    expect(out.followed).toBe(false);
    expect(out.verdict.observationLost).toBeUndefined();
  });
});
