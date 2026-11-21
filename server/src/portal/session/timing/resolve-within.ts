/**
 * Resolve a session, or spend the caller's stated budget waiting for one to arrive.
 *
 * Every tool that takes a `timeout_ms` used to resolve the session as its FIRST statement, so an
 * empty session map threw before the budget was ever consulted. A caller that said "wait up to
 * thirty seconds for the app" was refused in under a millisecond, and the only way to actually wait
 * was to poll `reticle_sessions` blind.
 *
 * That is the wrong answer to the commonest situation in the product. The moment an agent has run
 * `init` and restarted the dev server is exactly the moment there is no session yet and one is about
 * to appear — and `no_session` is the refusal agents hit most. An agent that gets refused rarely
 * retries; it concludes and moves on. Spending the budget it already asked for turns the most common
 * dead end into a wait that ends in a verdict.
 *
 * Deliberately narrow in two ways.
 *
 * Only the EMPTY case waits. A `sessionId` that names a session which is not connected while others
 * are is a different error with a different fix, and waiting on it would hide a typo behind a
 * timeout.
 *
 * The original error is what gets thrown on expiry, never a generic timeout message. That error
 * carries the daemon's whole diagnosis — the port scan, the next action, the literal command — and
 * it is the single most valuable string this product emits to an agent that has nothing connected.
 * Replacing it with "timed out" would trade the answer for a stopwatch reading.
 */

/** Just the part of the session manager this needs, so a test does not have to build one. */
export interface ResolvableSessions<S> {
  resolve: (sessionId?: string) => S;
  count: () => number;
}

/** How often to re-ask. A session appearing is an out-of-band event; this is a plain poll. */
const POLL_MS = 250;

export async function resolveSessionWithin<S>(
  sessions: ResolvableSessions<S>,
  sessionId: string | undefined,
  timeoutMs: number,
  deps: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<S> {
  try {
    return sessions.resolve(sessionId);
  } catch (first) {
    // Nothing to wait FOR unless the map is empty, and nothing to wait WITH unless a budget was
    // given. Either way the caller gets the same error it would have got before.
    if (timeoutMs <= 0 || sessions.count() > 0) {
      throw first;
    }
    const deadline = deps.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - deps.now();
      if (remaining <= 0) {
        throw first;
      }
      await deps.sleep(Math.min(POLL_MS, remaining));
      try {
        return sessions.resolve(sessionId);
      } catch {
        // Still nothing. Keep the FIRST error: it was raised when the daemon had most recently
        // computed its diagnosis, and re-throwing the newest one would report the same fact with a
        // staler explanation.
      }
    }
  }
}

/**
 * Resolve a session within `timeoutMs`, and say how much of `timeoutMs` is left.
 *
 * A tool that waits for the session and then for a predicate must give the predicate only what is
 * left. `reticle_assert` gave the full budget to each wait, so one call could run for two times its
 * `timeout_ms`. The MCP client stopped waiting first, and a verdict the daemon reached was lost
 * (#2443).
 */
export async function resolveSessionSpending<S>(
  sessions: ResolvableSessions<S>,
  sessionId: string | undefined,
  timeoutMs: number,
  deps: { now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<{ session: S; budgetMs: number; remainingMs: number; connectedLate: boolean }> {
  try {
    return {
      session: sessions.resolve(sessionId),
      budgetMs: timeoutMs,
      remainingMs: timeoutMs,
      connectedLate: false,
    };
  } catch {
    // No session yet: wait for one inside the budget, and report what the wait left.
  }
  const started = deps.now();
  const session = await resolveSessionWithin(sessions, sessionId, timeoutMs, deps);
  const remainingMs = Math.max(0, timeoutMs - (deps.now() - started));
  return { session, budgetMs: timeoutMs, remainingMs, connectedLate: true };
}

/**
 * The share of the budget the predicate must get before its `no` is a statement about the app.
 *
 * A session that connected 100 ms into a 10 s budget left the check most of its window, and its
 * `no` is correct. One that connected near the deadline left it a moment on a page that had just
 * connected. Half of the requested budget is the line between the two.
 */
const LATE_SESSION_MIN_SHARE = 0.5;

/**
 * A failed verdict on a session that connected late in the call, made inconclusive (#2443).
 *
 * Only when the predicate got less than {@link LATE_SESSION_MIN_SHARE} of the budget: then the check
 * ran briefly on a page that had just connected, so a `no` there is not a statement about the app.
 */
export function withLateSession<V extends { pass: boolean; inconclusive?: string }>(
  verdict: V,
  resolved: { budgetMs: number; remainingMs: number; connectedLate: boolean },
): V & { inconclusive?: string; failureReason?: string } {
  const shortWindow = resolved.remainingMs < resolved.budgetMs * LATE_SESSION_MIN_SHARE;
  if (
    !resolved.connectedLate ||
    !shortWindow ||
    verdict.pass ||
    verdict.inconclusive !== undefined
  ) {
    return verdict;
  }
  const reason =
    `the app connected ${String(resolved.remainingMs)} ms before the deadline, so the check ran on ` +
    'a page that had only just connected and was not decided. Call again, or give a longer timeout_ms';
  return { ...verdict, inconclusive: reason, failureReason: reason };
}
