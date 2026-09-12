/**
 * "The app ignored this response" is only sayable once the app has had a chance to read it.
 *
 * `response-ignored` fires when a write succeeded on the server and nothing on the client moved. It
 * is a real and valuable finding — a lost write, a response parsed into the void, a render that never
 * happened. It is also an ACCUSATION, and it is decided by where a window happens to end.
 *
 * Waiting for in-flight requests before taking the verdict made that boundary dangerous in a way it
 * was not before. Previously the write was still pending when the window closed, so it never reached
 * the settled list and this rule could not fire at all. Now the response lands inside the window BY
 * DESIGN — and the app's re-render happens in a later task, a few milliseconds after it. Close the
 * window in that gap and every channel agrees that the app took a successful write and did nothing.
 *
 * The verdict is then `verified:"no"` on a completely correct application, produced entirely by where
 * we chose to stop looking. For a verification tool that is the more damaging direction of error: a
 * false green is a missed catch, but a false accusation sends someone to fix code that is not broken,
 * and it is how the instrument stops being believed.
 *
 * So the response is not the end of the window — the app's REACTION to it is. The grace is paid only
 * in the exact case that would otherwise be accused: a successful mutating write with nothing moved
 * after it. Every other action returns without a single poll.
 *
 * Deliberately short. This covers a task-boundary re-render, not a slow app: if nothing has moved
 * within the grace, "ignored" has become an honest description and the finding should stand.
 */

import { EventType, MUTATING_METHODS } from '@reticlehq/core';
import type { SettleSource } from './settle-in-flight.js';

/**
 * How long to let the app react. A React commit after a resolved fetch is one or two task hops; this
 * is generous against that and still far too short to paper over an app that genuinely dropped the
 * response.
 */
const REACTION_GRACE_MS = 300;

/** Poll cadence — the same as the settle wait, for the same reason. */
const POLL_MS = 50;

/** Movement that would clear `response-ignored`; mirrors `uiAdvanced` in the detector. */
const MOVEMENT = new Set<string>([
  EventType.DOM_ADDED,
  EventType.DOM_REMOVED,
  EventType.DOM_ATTR,
  EventType.DOM_TEXT,
  EventType.STATE_CHANGE,
  EventType.ROUTE_CHANGE,
]);

function moved(events: readonly { type: string }[]): boolean {
  return events.some((e) => MOVEMENT.has(e.type));
}

/**
 * Is this a window that would be wrongly accused if it ended right now?
 *
 * True only for the accusable shape: a SUCCESSFUL MUTATING request settled, and nothing has moved. A
 * read that changed nothing is a prefetch, a failed write is a different finding entirely, and an
 * action that already moved the UI has nothing to wait for — none of them buy a grace period.
 *
 * "Mutating" is read from the same constant the accuser uses rather than restated here. Restating it
 * is how `IPC` came to be absent from this list and present in that one, so on a desktop app every
 * successful write skipped the grace and a correct app was told it had ignored its own response.
 */
export function awaitsReaction(
  events: readonly { type: string; data: Record<string, unknown> }[],
): boolean {
  if (moved(events)) return false;
  return events.some((e) => {
    if (e.type !== EventType.NET_REQUEST) return false;
    const method = 'string' === typeof e.data['method'] ? e.data['method'].toUpperCase() : '';
    const ok = e.data['ok'];
    return MUTATING_METHODS.includes(method) && true === ok;
  });
}

/**
 * Wait, bounded by BOTH the grace and the caller's remaining budget, for the app to react to a write
 * it has just been told succeeded.
 *
 * Returns whether the app moved. A `false` is not a verdict — it hands the question back to the
 * contradiction engine, which will raise `response-ignored` exactly as it does today. The point is
 * only that by then the app has been given its chance, so the finding means what it says.
 */
export async function waitForReaction(
  session: SettleSource,
  since: number,
  budgetMs: number,
  opts: { sleep(ms: number): Promise<void> },
): Promise<boolean> {
  if (!awaitsReaction(session.eventsSince(since))) return true;
  const window = Math.min(REACTION_GRACE_MS, budgetMs);
  if (window <= 0) return false;

  const deadline = session.elapsed() + window;
  while (session.elapsed() < deadline) {
    await opts.sleep(Math.min(POLL_MS, deadline - session.elapsed()));
    if (moved(session.eventsSince(since))) return true;
  }
  return false;
}
