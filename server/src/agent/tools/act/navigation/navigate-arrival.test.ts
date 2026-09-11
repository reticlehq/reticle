/**
 * `confirmed` used to be `false` on every navigation on every app. These prove it now varies with
 * reality — and, just as importantly, that a navigation nobody arrives at still ANSWERS rather than
 * hanging.
 *
 * The clock is injected, so none of this asserts a duration. Per CLAUDE.md: if the property is
 * "cost is bounded", assert the bound — here, that the loop terminates and how many times it looked
 * — never elapsed milliseconds, which is a statement about the machine.
 */

import { describe, expect, it } from 'vitest';
import { awaitArrival, idsAtTarget, type ArrivalScope } from './navigate-arrival.js';
import type { SessionManager } from '../../../../connection/session/session-manager.js';

/** Just enough SessionManager for `awaitArrival`, which only ever calls `all()`. */
function fakeSessions(urlsOverTime: { id: string; url: string }[][]): {
  sessions: SessionManager;
  looks: () => number;
} {
  let look = 0;
  const sessions = {
    all: () => {
      const snapshot = urlsOverTime[Math.min(look, urlsOverTime.length - 1)] ?? [];
      look++;
      return snapshot;
    },
  } as unknown as SessionManager;
  return { sessions, looks: () => look };
}

/** A clock that advances only when slept on, so the test is deterministic and instant. */
function fakeClock(step: number): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: () => {
      t += step;
      return Promise.resolve();
    },
  };
}

const TARGET = 'http://localhost:3000/dashboard';

/** The navigation drove `id`, and nothing was sitting on the target beforehand. */
function drove(id: string): ArrivalScope {
  return { navigatedId: id, priorIds: new Set() };
}

describe('awaitArrival', () => {
  // Renamed: "already at the target" now names the case this must IGNORE — a session that was
  // there BEFORE the navigation. This one is about arriving without having to wait.
  it('confirms on the first look when the arriving session is already present', async () => {
    const { sessions } = fakeSessions([[{ id: 's1', url: TARGET }]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 5_000, fakeClock(100)),
    ).resolves.toEqual({
      sessionId: 's1',
    });
  });

  it('waits for one that arrives a few polls later', async () => {
    const { sessions } = fakeSessions([[], [], [{ id: 's2', url: TARGET }]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 5_000, fakeClock(100)),
    ).resolves.toEqual({
      sessionId: 's2',
    });
  });

  it('gives up and returns null rather than hanging when nothing arrives', async () => {
    const { sessions, looks } = fakeSessions([[]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 500, fakeClock(100)),
    ).resolves.toBeNull();
    // The BOUND, not the duration: a 500ms budget at 100ms per poll looks a handful of times.
    expect(looks()).toBeLessThanOrEqual(7);
  });

  it('ignores a session sitting on a different page', async () => {
    const { sessions } = fakeSessions([[{ id: 'other', url: 'http://localhost:3000/settings' }]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 300, fakeClock(100)),
    ).resolves.toBeNull();
  });

  /**
   * The app is entitled to rewrite query and hash on arrival — an auth guard appending
   * `?redirect=`, a router normalising a trailing slash. Demanding an exact URL match would report
   * `confirmed:false` for a navigation that plainly worked, which is the same lie in reverse.
   */
  it('confirms arrival when the app added a query string', async () => {
    const { sessions } = fakeSessions([
      [{ id: 's3', url: 'http://localhost:3000/dashboard?redirect=%2F' }],
    ]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 500, fakeClock(100)),
    ).resolves.toEqual({
      sessionId: 's3',
    });
  });

  it('and when only a trailing slash differs', async () => {
    const { sessions } = fakeSessions([[{ id: 's4', url: 'http://localhost:3000/dashboard/' }]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 500, fakeClock(100)),
    ).resolves.toEqual({
      sessionId: 's4',
    });
  });

  it('ignores a session that was already sitting on the target before the navigation', async () => {
    // The defect. A stale row parked on this origin — in the field report, one belonging to a
    // different app that had previously held the same port — matched the scan and was reported as
    // the session you had arrived at. It was there before the navigation, so it is evidence of
    // nothing about it.
    const { sessions } = fakeSessions([[{ id: 'zombie', url: TARGET }]]);
    const scope: ArrivalScope = { navigatedId: 'driven', priorIds: new Set(['zombie']) };
    await expect(awaitArrival(sessions, TARGET, scope, 300, fakeClock(100))).resolves.toBeNull();
  });

  it('confirms the driven session even when it was already at the target', async () => {
    // A reload, or a route change that keeps the document: the navigated session is legitimately at
    // the target both before and after, under the same id. Excluding it would report confirmed:false
    // for the navigation most likely to have worked.
    const { sessions } = fakeSessions([[{ id: 'driven', url: TARGET }]]);
    const scope: ArrivalScope = { navigatedId: 'driven', priorIds: new Set(['driven']) };
    await expect(awaitArrival(sessions, TARGET, scope, 500, fakeClock(100))).resolves.toEqual({
      sessionId: 'driven',
    });
  });

  it('reports the session that actually arrived, not the zombie scanned before it', async () => {
    // `sessions.all()` is Map insertion order, so an older stale row is scanned FIRST. That is what
    // made the wrong id the likely answer rather than a coin flip.
    const { sessions } = fakeSessions([
      [
        { id: 'zombie', url: TARGET },
        { id: 'fresh', url: TARGET },
      ],
    ]);
    const scope: ArrivalScope = { navigatedId: 'driven', priorIds: new Set(['zombie']) };
    await expect(awaitArrival(sessions, TARGET, scope, 500, fakeClock(100))).resolves.toEqual({
      sessionId: 'fresh',
    });
  });

  it('prefers the driven session over another new arrival on the same page', async () => {
    // Two candidates and one of them is the tab we drove: it is the answer, not a tie to break by
    // scan order.
    const { sessions } = fakeSessions([
      [
        { id: 'bystander', url: TARGET },
        { id: 'driven', url: TARGET },
      ],
    ]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 500, fakeClock(100)),
    ).resolves.toEqual({ sessionId: 'driven' });
  });

  it('does not confirm a same-path page on a different origin', async () => {
    const { sessions } = fakeSessions([[{ id: 'x', url: 'http://localhost:9999/dashboard' }]]);
    await expect(
      awaitArrival(sessions, TARGET, drove('driven'), 300, fakeClock(100)),
    ).resolves.toBeNull();
  });
});

describe('idsAtTarget', () => {
  it('names the sessions already on the target, so arrival can exclude them', () => {
    const { sessions } = fakeSessions([
      [
        { id: 'here', url: 'http://localhost:3000/dashboard?x=1' },
        { id: 'elsewhere', url: 'http://localhost:3000/settings' },
        { id: 'other-origin', url: 'http://localhost:9999/dashboard' },
      ],
    ]);
    // Same origin+pathname rule the arrival scan uses — one function, so the "was it already there"
    // question and the "is it there now" question can never disagree.
    expect([...idsAtTarget(sessions, TARGET)]).toEqual(['here']);
  });
});
