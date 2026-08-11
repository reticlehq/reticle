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
import { awaitArrival } from './navigate-arrival.js';
import type { SessionManager } from '../session/session-manager.js';

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

describe('awaitArrival', () => {
  it('finds a session already at the target on the first look', async () => {
    const { sessions } = fakeSessions([[{ id: 's1', url: TARGET }]]);
    await expect(awaitArrival(sessions, TARGET, 5_000, fakeClock(100))).resolves.toEqual({
      sessionId: 's1',
    });
  });

  it('waits for one that arrives a few polls later', async () => {
    const { sessions } = fakeSessions([[], [], [{ id: 's2', url: TARGET }]]);
    await expect(awaitArrival(sessions, TARGET, 5_000, fakeClock(100))).resolves.toEqual({
      sessionId: 's2',
    });
  });

  it('gives up and returns null rather than hanging when nothing arrives', async () => {
    const { sessions, looks } = fakeSessions([[]]);
    await expect(awaitArrival(sessions, TARGET, 500, fakeClock(100))).resolves.toBeNull();
    // The BOUND, not the duration: a 500ms budget at 100ms per poll looks a handful of times.
    expect(looks()).toBeLessThanOrEqual(7);
  });

  it('ignores a session sitting on a different page', async () => {
    const { sessions } = fakeSessions([[{ id: 'other', url: 'http://localhost:3000/settings' }]]);
    await expect(awaitArrival(sessions, TARGET, 300, fakeClock(100))).resolves.toBeNull();
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
    await expect(awaitArrival(sessions, TARGET, 500, fakeClock(100))).resolves.toEqual({
      sessionId: 's3',
    });
  });

  it('and when only a trailing slash differs', async () => {
    const { sessions } = fakeSessions([[{ id: 's4', url: 'http://localhost:3000/dashboard/' }]]);
    await expect(awaitArrival(sessions, TARGET, 500, fakeClock(100))).resolves.toEqual({
      sessionId: 's4',
    });
  });

  it('does not confirm a same-path page on a different origin', async () => {
    const { sessions } = fakeSessions([[{ id: 'x', url: 'http://localhost:9999/dashboard' }]]);
    await expect(awaitArrival(sessions, TARGET, 300, fakeClock(100))).resolves.toBeNull();
  });
});
