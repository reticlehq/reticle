/**
 * The other navigation shape (#2009), covered by `followLostObservation`'s second phase.
 *
 * An app whose sign-in backend answers slowly moves the page AFTER the act budget has expired: the
 * wait graded the route on the document BEFORE it left ("current route '/login', expected
 * '/today'"), the page re-announced on /today a second later, and the agent read a failure for a
 * sign-in that worked. Phase 1 of `followLostObservation` covers a wait CUT OFF mid-predicate;
 * these tests lock phase 2 — a failure that gets a bounded grace to see whether the document's
 * successor arrives, follows it when it does, and says exactly that when it does not. A pass, an
 * already-lost verdict, and a session that merely reconnected as itself are all left alone.
 */
import { describe, expect, it } from 'vitest';
import { NAVIGATION_FOLLOW_GRACE_MS, followLostObservation } from './act-observation.js';
import type { Session } from '@/portal/session/session.js';
import type { EvalResult } from '@reticlehq/engine/question/predicate/predicate-eval.js';

const failed = (): EvalResult => ({
  pass: false,
  failureReason: "current route '/login', expected '/today'",
});
const passed = (): EvalResult => ({ pass: true });

const fakeSession = (
  id: string,
  url: string,
  opts: { staleMs?: number; agentIdleMs?: number; elapsed?: number } = {},
): Session =>
  ({
    id,
    url,
    staleMs: () => opts.staleMs ?? 1_000,
    agentIdleMs: () => opts.agentIdleMs ?? 500,
    elapsed: () => opts.elapsed ?? 0,
    command: () => Promise.reject(new Error('fake')),
    eventsSince: () => [],
    onEvent: () => () => undefined,
    pushEvent: (_event: unknown) => undefined,
  }) as unknown as Session;

/** Ticking fake clock: every `now()` advances a full grace, so the poll always expires. */
const tickingClock = () => {
  let t = 0;
  return { now: () => (t += NAVIGATION_FOLLOW_GRACE_MS), sleep: () => Promise.resolve() };
};
const frozenClock = { now: () => 0, sleep: () => Promise.resolve() };

const registry = (sessions: Session[]) => ({
  get: (id: string) => sessions.find((s) => s.id === id),
  all: () => sessions,
});

const LOGIN = 'http://app.test/login?__reticle_session=lease-1';
const TODAY = 'http://app.test/today';

describe('phase 2 — a failure graded while the navigation was in flight', () => {
  it('follows the document that took over and re-asks there', async () => {
    const departed = fakeSession('a', LOGIN);
    // The real successor claims the lease marker: the pool's init script re-stamps it on the
    // redirected document (#1381). A claimless successor would be REFUSED by mayInherit —
    // correctly, since an unclaimed tab at the origin might be somebody else's.
    const successor = fakeSession('b', `${TODAY}?__reticle_session=lease-1`, {
      staleMs: 100,
      agentIdleMs: 500,
    });
    const out = await followLostObservation({
      sessions: registry([successor]),
      session: departed,
      verdict: failed(),
      timeout: 5_000,
      predicateStarted: 0,
      failedFollowGraceMs: NAVIGATION_FOLLOW_GRACE_MS,
      reevaluate: (s, budget) => {
        expect(s.id).toBe('b');
        expect(budget).toBe(NAVIGATION_FOLLOW_GRACE_MS);
        return Promise.resolve(passed());
      },
      clock: frozenClock,
    });

    expect(out.followed).toBe(true);
    expect(out.session.id).toBe('b');
    expect(out.verdict.pass).toBe(true);
  });

  it('answers with the navigation itself when no successor connects within the grace', async () => {
    const departed = fakeSession('a', LOGIN);
    const out = await followLostObservation({
      sessions: registry([departed]),
      session: departed,
      verdict: failed(),
      timeout: 5_000,
      predicateStarted: 0,
      failedFollowGraceMs: NAVIGATION_FOLLOW_GRACE_MS,
      reevaluate: () => Promise.resolve(passed()),
      clock: tickingClock(),
    });

    expect(out.followed).toBe(false);
    expect(out.verdict.pass).toBe(false);
    expect(out.verdict.observationLost).toBe(true);
    expect(out.verdict.failureReason).toContain('left its document');
    expect(out.verdict.failureReason).toContain('no successor session connected');
  });

  it('does not follow a session that merely reconnected as itself', async () => {
    const departed = fakeSession('a', LOGIN);
    const out = await followLostObservation({
      sessions: registry([departed]),
      session: departed,
      verdict: failed(),
      timeout: 5_000,
      predicateStarted: 0,
      failedFollowGraceMs: NAVIGATION_FOLLOW_GRACE_MS,
      reevaluate: () => Promise.resolve(passed()),
      clock: tickingClock(),
    });

    expect(out.followed).toBe(false);
    expect(out.verdict.observationLost).toBe(true);
  });

  it('leaves a PASS alone — only failures can be a graded-on-a-leaving-document mistake', async () => {
    const verdict = passed();
    const out = await followLostObservation({
      sessions: registry([fakeSession('a', LOGIN)]),
      session: fakeSession('a', LOGIN),
      verdict,
      timeout: 5_000,
      predicateStarted: 0,
      failedFollowGraceMs: NAVIGATION_FOLLOW_GRACE_MS,
      reevaluate: () => Promise.resolve(passed()),
      clock: tickingClock(),
    });

    expect(out.followed).toBe(false);
    expect(out.verdict).toBe(verdict);
  });

  it('keeps the old behaviour when the caller grants no grace', async () => {
    const out = await followLostObservation({
      sessions: registry([fakeSession('a', LOGIN)]),
      session: fakeSession('a', LOGIN),
      verdict: failed(),
      timeout: 5_000,
      predicateStarted: 0,
      reevaluate: () => Promise.resolve(passed()),
      clock: tickingClock(),
    });

    expect(out.followed).toBe(false);
    expect(out.verdict.observationLost).toBeUndefined();
  });
});
