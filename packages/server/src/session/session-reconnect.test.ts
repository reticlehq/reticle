/**
 * A reload strands the agent for as long as the page takes to come back.
 *
 * The id survives (session-continuity remembers it in sessionStorage) and the daemon accepts the
 * returning page under that same id — but between the dispatch and the new HELLO there is a window,
 * a second or two of dev-server rebuild, where the session is the OLD disconnected object. The
 * agent's very next call lands in it: measured as `reticle_run` failing 5 of 5 and crawl answering
 * "session disconnected", on a page that was perfectly healthy a moment later.
 *
 * Telling the agent to "call reticle_sessions first" is advice; waiting for the reconnect is a fix.
 * Pure loop, injected clock and sleep, so it is tested without real timers.
 */

import { describe, expect, it } from 'vitest';
import { waitForReconnect } from './session-reconnect.js';

/** A fake clock whose `sleep` simply advances it — no real timers, no flake. */
function fakeTime(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

describe('waiting for a reloaded page to come back', () => {
  it('resolves as soon as a DIFFERENT session object holds the id', async () => {
    const time = fakeTime();
    const previous = { id: 'a' };
    let live: object | undefined = previous;
    // The page comes back on the third poll.
    let polls = 0;
    const current = (): object | undefined => {
      polls += 1;
      if (polls >= 3) live = { id: 'a' };
      return live;
    };
    expect(await waitForReconnect({ current, previous, timeoutMs: 5000, ...time })).toBe(true);
  });

  it('gives up at the timeout rather than blocking the agent forever', async () => {
    const time = fakeTime();
    const previous = { id: 'a' };
    expect(
      await waitForReconnect({ current: () => previous, previous, timeoutMs: 500, ...time }),
    ).toBe(false);
    // It waited, it did not spin: the injected clock advanced by the poll interval each turn.
    expect(time.now()).toBeGreaterThanOrEqual(500);
  });

  it('a session that vanished entirely is not a reconnect', async () => {
    const time = fakeTime();
    const previous = { id: 'a' };
    expect(
      await waitForReconnect({ current: () => undefined, previous, timeoutMs: 300, ...time }),
    ).toBe(false);
  });
});
