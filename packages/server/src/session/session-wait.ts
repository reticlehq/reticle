/**
 * Spend a caller's `timeout_ms` waiting for the app to come back, instead of refusing instantly.
 *
 * `reticle_assert`, `reticle_wait_for` and `reticle_act_and_wait` all resolved a session as their
 * FIRST statement, so `resolve`'s no-session error was raised before the timeout argument was even
 * read. A caller that said "wait up to 30s for this to hold" was refused in under a millisecond
 * because the app was not back yet — and the documented workaround was polling `reticle_sessions`
 * blind, which is this same wait with the waiting done by hand, one round trip at a time.
 *
 * Measured against the case that motivates it: a Nuxt SPA with HMR active reattaches in 30–60s.
 * Anything that refuses at t=0 is guaranteed to miss it.
 */
import { NoSessionConnectedError, type SessionManager } from './session-manager.js';
import type { Session } from './session.js';

/**
 * How often to look for a session that has not arrived yet.
 *
 * A connect is a websocket handshake, not a computation: checking costs a `Map` lookup, while
 * checking too slowly adds dead time to every reconnect an agent sits through.
 */
const SESSION_ARRIVAL_POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resume) => setTimeout(resume, ms));

/**
 * Resolve a session, waiting up to `timeoutMs` for a first one to connect.
 *
 * Only `NoSessionConnectedError` is waited through. Every other refusal `resolve` raises is about
 * sessions that already exist and is re-thrown at once, because no amount of waiting changes it.
 *
 * The final attempt's error is what reaches the caller, so a session that never arrives still gets
 * `resolve`'s full diagnosis — which names which of the three causes this is — rather than a thinner
 * "timed out" that throws that diagnosis away.
 *
 * @param sessions The manager to resolve against.
 * @param timeoutMs Budget for a session to appear. `<= 0` is exactly the old behaviour.
 * @param sessionId Optional explicit target, passed straight through to `resolve`.
 */
export async function resolveWaitingForSession(
  sessions: SessionManager,
  timeoutMs: number,
  sessionId?: string,
): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return sessions.resolve(sessionId);
    } catch (error) {
      const waitable = error instanceof NoSessionConnectedError && Date.now() < deadline;
      if (!waitable) throw error;
    }
    await sleep(SESSION_ARRIVAL_POLL_MS);
  }
}
