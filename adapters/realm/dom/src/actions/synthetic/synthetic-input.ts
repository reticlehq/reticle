/**
 * Is the input event currently being dispatched one that RETICLE made?
 *
 * The annotator listens for clicks in the capture phase and cancels them, because a click in
 * annotate mode is a request to place a mark rather than a request to press a button. That is right
 * for a person and wrong for the agent: `reticle_act` dispatches its clicks into the same document,
 * so with the HUD expanded every agent click was swallowed while the action still reported
 * `dispatched: true`. Measured on this repo's own fixture — the same click that produced
 * `POST /api/login -> 200` with annotate off produced no network at all with it on.
 *
 * `isTrusted` looks like the answer and is not usable: it is false for everything `dispatchEvent`
 * creates, which is also how every test in this package drives the annotator, so gating on it would
 * make annotation untestable and would still not distinguish Reticle's clicks from the page's own
 * synthetic ones.
 *
 * So Reticle marks its own. Dispatch is synchronous, so a plain depth counter held across the call
 * is exact: any listener running inside it — capture phase included — is running because of us.
 * Nested actions are counted rather than flagged, so an inner action finishing does not clear the
 * mark for the outer one still in flight.
 */
let depth = 0;

/** True while a Reticle-dispatched input event is being delivered. */
export function isSyntheticInput(): boolean {
  return depth > 0;
}

/**
 * Run `dispatch` marked as Reticle's own.
 *
 * `finally` rather than a trailing decrement: a listener that throws must not leave the flag stuck
 * on, which would silently disable annotation for the rest of the page's life.
 */
export function asSyntheticInput<T>(dispatch: () => T): T {
  depth += 1;
  try {
    return dispatch();
  } finally {
    depth -= 1;
  }
}
