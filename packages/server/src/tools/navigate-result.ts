/**
 * The honest envelope for a navigation nobody can confirm.
 *
 * `window.location.assign(url)` returns before the page moves, and the SDK that would report on the
 * new document is destroyed by the navigation itself. So a successful NAVIGATE means the browser
 * accepted the instruction — not that anything arrived. Driven against a dead URL it returned
 * `{"ok":true}` while the session died, which is the worst combination available: the agent believes
 * it navigated, is looking at nothing, and has lost Reticle.
 *
 * `reticle_act` already draws this line — `dispatched` (sent) versus `settled` (a frame flushed).
 * This gives navigate the same honesty without changing what it does.
 */
/** The session the SDK reconnected as after the page moved, when one was observed in the window. */
export interface NavigateArrival {
  sessionId: string;
}

export function navigateResult(
  result: {
    ok?: unknown;
    url?: unknown;
    reason?: unknown;
  },
  /**
   * Arrival, if the daemon saw the SDK come back. `null` keeps the original honest envelope.
   *
   * Measured on three fixtures: `confirmed` was `false` on every navigation on every app, because
   * nothing ever set it. A boolean that never varies teaches an agent nothing, and an agent that
   * learns to ignore it will keep ignoring it when it starts meaning something. The daemon is the
   * one place that CAN answer this — the SDK reconnects to it — so making it answer removes a
   * `reticle_sessions` poll from every single navigation.
   */
  arrival: NavigateArrival | null = null,
): Record<string, unknown> {
  const ok = true === result.ok;
  const base: Record<string, unknown> = {
    ok,
    ...('string' === typeof result.url ? { url: result.url } : {}),
    ...('string' === typeof result.reason ? { reason: result.reason } : {}),
  };
  // A refusal is conclusive: the page never moved, so there is nothing unconfirmed to report.
  if (!ok) return base;
  if (arrival !== null) {
    return {
      ...base,
      confirmed: true,
      // The SDK that reconnects after a navigation is a NEW session with a new id. Returning it here
      // is the difference between a confirmation and a confirmation the agent can act on.
      sessionId: arrival.sessionId,
    };
  }
  return {
    ...base,
    confirmed: false,
    note:
      'ok means the navigation was DISPATCHED, not that the page arrived — the SDK is torn down by ' +
      'the navigation itself, so nothing here can see the new document. Call reticle_sessions to ' +
      'confirm a session reconnected at the new URL before acting; if none appears, the page did ' +
      'not load or is not instrumented.',
  };
}
