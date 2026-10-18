/**
 * A zero-match `find` read while the last act is still landing says so (#1259).
 *
 * `reticle_act` returns before an async render: a click that opens a modal after a fetch, then an
 * immediate `find` for the modal's combobox, answers 0. A find is a point-in-time read, and an agent
 * reads 0 as "not there" and goes down the wrong path. The read itself stays instant. What changes
 * is that a 0 taken while the page is demonstrably still moving carries `unsettled`, naming why and
 * the call that waits.
 */
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { inFlightRequestLabels } from './settle-in-flight.js';

/** A DOM change this recent means the render the act started may not have landed yet. */
export const UNSETTLED_DOM_QUIET_MS = 500;

const DOM_CHANGES: ReadonlySet<string> = new Set([
  EventType.DOM_ADDED,
  EventType.DOM_REMOVED,
  EventType.DOM_ATTR,
  EventType.DOM_TEXT,
]);

/** What the next call should be, in the words every unsettled answer uses. */
const WAIT_INSTEAD =
  'a 0 here may only mean it has not rendered yet. Wait for it with reticle_assert { action: "wait", predicate: { kind: "element", query: ... } }, or act with reticle_act_and_wait { until } next time';

export interface UnsettledFind {
  reason: string;
  inFlight?: string[];
  lastDomChangeMsAgo?: number;
}

/** The slice of a session this reads: the last act's window and the clock. */
export interface UnsettledFindSession {
  lastAct: { cursor(): number | undefined };
  eventsSince(cursor: number): readonly ReticleEvent[];
  elapsed(): number;
  url: string;
  background: readonly string[];
}

/** How many elements a query result matched, or `undefined` when it is not a query result. */
function matchedCount(result: unknown): number | undefined {
  if (null === result || 'object' !== typeof result) return undefined;
  const rec = result as Record<string, unknown>;
  if ('number' === typeof rec['count']) return rec['count'];
  return Array.isArray(rec['elements']) ? rec['elements'].length : undefined;
}

/**
 * `unsettled` for a zero-match read taken while the last act's window is still moving, else nothing.
 *
 * Moving means a request that window started has not come back, or the DOM changed within
 * `UNSETTLED_DOM_QUIET_MS`. With no act yet there is no window to judge, so nothing is said.
 */
export function unsettledFind(
  session: UnsettledFindSession,
  result: unknown,
): UnsettledFind | undefined {
  if (0 !== matchedCount(result)) return undefined;
  // A test double, or any session that cannot say what its last act was, gets the read as before.
  if (undefined === (session as Partial<UnsettledFindSession>).lastAct) return undefined;
  const cursor = session.lastAct.cursor();
  if (cursor === undefined) return undefined;
  const window = session.eventsSince(cursor);
  const inFlight = inFlightRequestLabels(window, session.url, session.background);
  let lastDom: number | undefined;
  for (const e of window) if (DOM_CHANGES.has(e.type)) lastDom = Math.max(lastDom ?? e.t, e.t);
  const msAgo = lastDom === undefined ? undefined : Math.max(0, session.elapsed() - lastDom);
  const recent = msAgo !== undefined && msAgo < UNSETTLED_DOM_QUIET_MS;
  if (0 === inFlight.length && !recent) return undefined;
  const why =
    0 < inFlight.length
      ? `the last act started ${String(inFlight.length)} request(s) that have not come back`
      : `the page changed ${String(msAgo)} ms ago, after the last act`;
  return {
    reason: `this read found nothing while the page was still changing: ${why}, so ${WAIT_INSTEAD}`,
    ...(0 < inFlight.length ? { inFlight } : {}),
    ...(msAgo === undefined ? {} : { lastDomChangeMsAgo: msAgo }),
  };
}

/** The query result, with `unsettled` added when a zero-match read was taken mid-render. */
export function withUnsettledFind(session: UnsettledFindSession, result: unknown): unknown {
  const unsettled = unsettledFind(session, result);
  if (unsettled === undefined || null === result || 'object' !== typeof result) return result;
  return { ...(result as Record<string, unknown>), unsettled };
}
