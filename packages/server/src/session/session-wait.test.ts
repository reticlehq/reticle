/**
 * `timeout_ms` was inert when there was no session yet.
 *
 * `reticle_assert`, `reticle_wait_for` and `reticle_act_and_wait` resolved a session as their FIRST
 * statement, so `resolve`'s no-session error was raised before the timeout argument was read. A
 * caller that said "wait up to N seconds for this to hold" was refused in under a millisecond
 * because the app was not back YET, and the only workaround was polling `reticle_sessions` blind —
 * the same wait, done by hand, one round trip at a time.
 *
 * The distinction these pin is which refusals are worth waiting through. "Nothing is connected" is
 * the app not being back yet. "Two tabs are connected" or "that id is unknown" are facts about
 * sessions that already exist, and waiting only delays an answer that was already correct.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveWaitingForSession } from './session-wait.js';
import { NoSessionConnectedError, type SessionManager } from './session-manager.js';
import type { Session } from './session.js';

const SESSION = { id: 's-1' } as Session;

/** A manager whose `resolve` refuses `failures` times, then succeeds. */
function connectsAfter(failures: number, error: () => Error): SessionManager {
  let calls = 0;
  const resolve = (): Session => {
    calls += 1;
    if (calls <= failures) throw error();
    return SESSION;
  };
  return { resolve, calls: () => calls } as unknown as SessionManager;
}

const noSession = (): Error => new NoSessionConnectedError('nothing is connected');
const ambiguous = (): Error =>
  new Error('multiple sessions connected — pass sessionId to target one');

describe('a wait spends the budget it was given', () => {
  it('returns the session that arrives during the timeout', async () => {
    const sessions = connectsAfter(3, noSession);

    const session = await resolveWaitingForSession(sessions, 5_000);

    expect(session).toBe(SESSION);
  });

  it('refuses at once when the caller asked to wait for nothing', async () => {
    // timeout_ms 0 is a documented mode — evaluate now, do not wait — so it must stay instant.
    const sessions = connectsAfter(1, noSession);

    await expect(resolveWaitingForSession(sessions, 0)).rejects.toThrow('nothing is connected');
    expect((sessions as unknown as { calls: () => number }).calls()).toBe(1);
  });

  it('gives up with resolve\'s own diagnosis, not a thinner "timed out"', async () => {
    // The daemon replaces this message with a real diagnosis when it has one — which of the three
    // causes this is. A wait that swallowed it would discard the most useful thing on the call.
    const sessions = connectsAfter(Number.MAX_SAFE_INTEGER, () =>
      Object.assign(new NoSessionConnectedError('the app is not dialling this daemon'), {}),
    );

    await expect(resolveWaitingForSession(sessions, 250)).rejects.toThrow(
      'the app is not dialling this daemon',
    );
  });
});

describe('only the refusal that TIME can fix is waited through', () => {
  it('re-throws an ambiguity immediately — a second tab is not a slow connect', async () => {
    // Waiting here would turn an instant, accurate answer into the same answer N seconds later.
    const sessions = connectsAfter(1, ambiguous);

    await expect(resolveWaitingForSession(sessions, 30_000)).rejects.toThrow(
      'multiple sessions connected',
    );
    expect((sessions as unknown as { calls: () => number }).calls()).toBe(1);
  });

  it('does not busy-loop: it polls, rather than hammering resolve', async () => {
    vi.useFakeTimers();
    try {
      const sessions = connectsAfter(Number.MAX_SAFE_INTEGER, noSession);
      const pending = resolveWaitingForSession(sessions, 1_000).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      // 1s of budget at a 100ms poll is ~11 attempts, not thousands.
      expect((sessions as unknown as { calls: () => number }).calls()).toBeLessThan(20);
    } finally {
      vi.useRealTimers();
    }
  });
});
