import type { EventType } from '@reticlehq/core';

/** An observer emits normalized events; the orchestrator stamps time + forwards them. */
export type Emit = (type: EventType, data: Record<string, unknown>, ref?: string) => void;

/** Every observer returns a teardown that fully restores any patched globals. */
export type Teardown = () => void;

/**
 * Run an observation so it can never escape into the app's call stack.
 *
 * Every monkey-patch calls its observation INSIDE the function it replaced, so a throw does not surface
 * as an SDK error — it propagates out of `localStorage.setItem` after the write already succeeded, out
 * of `history.pushState` (crashing a router's navigate), or out of `console.log` before the message
 * reaches the console. Guarding the transport hop alone is not enough: the payload is BUILT here too
 * (reading the old value, resolving the area, redacting), and any of that can throw on a hostile or
 * exotic object.
 *
 * A dev-only observability SDK must never be able to break the app it is observing.
 */
export function observeSafely(observation: () => void): void {
  try {
    observation();
  } catch {
    /* observation is best-effort; the host app's control flow is not */
  }
}

/** Like observeSafely, but for reading a value the observation needs; undefined if the read throws. */
export function observeValue<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
