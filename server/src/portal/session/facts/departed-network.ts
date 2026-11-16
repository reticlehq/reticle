/**
 * Carry the network record of a document that unloaded into the session of the next document (#1944).
 *
 * A click on "Sign out" sends a POST and then loads `/sign-in`. The old document sends the POST's
 * records before it unloads, so the daemon has them. But the new document connects as a new
 * `Session` under the same id, and the act's verdict, every later `reticle_observe { action:
 * "network" }` and every later `reticle_assert` read only that session. The POST went away with the
 * old `Session` object, and a `net` check on a real request answered "no call matched".
 *
 * What is carried, and why only that:
 *
 * - Only the network records from the start of the agent's newest action on the old document. Those
 *   are the window that the act's verdict and the agent's next check read. Nothing is carried when
 *   no agent acted, so a person's own reloads do not move old traffic into a new page.
 * - Not the departure record (`NetInitiator.NAVIGATION`). The new document records its own load.
 * - Only when the new session's first stamped event is from a DIFFERENT document. The same document
 *   reconnecting after a bridge outage did not unload, and its requests can still be answered.
 *
 * How the loss is declared (AGENTS.md rule 11):
 *
 * - Every carried record has `fromDepartedDocument: true`. Its `t` is when it was carried, so it
 *   cannot show where the request was in the old document's timeline.
 * - A request that failed with status 0 is not carried as a failure: the browser cancels a leaving
 *   document's requests, so that status is not the server's answer (see `abortedByUnload`).
 * - A request that had no answer is marked `pageUnloaded: true`. Its answer went to a document that
 *   no longer exists. Its outcome is unknown: `net` checks that rest on it are `unknown`, never `no`,
 *   and settle does not wait for it (`neverAnswered`).
 * - `documentId`, `seq`, `actionId` and `attribution` are removed. They are about the old document
 *   and its journal, and kept here they would make the old document the current one again.
 */

import {
  DepartedNetField,
  EventType,
  NetInitiator,
  asString,
  type ReticleEvent,
} from '@reticlehq/core';

/** The records of one request. Streams are left out: an open stream would hold settle open. */
const CARRIED_TYPES: ReadonlySet<string> = new Set([
  EventType.NET_PENDING,
  EventType.NET_REQUEST,
  EventType.NET_RESPONSE_BODY,
]);

/** What the old document sent, and which document it was. */
export interface DepartedNetwork {
  /** The old document's id, or undefined when its SDK does not stamp one. */
  readonly documentId: string | undefined;
  readonly events: readonly ReticleEvent[];
}

/** The part of a `Session` this needs. A real `Session` satisfies it. */
export interface DepartingSession {
  readonly currentDocumentId: string | undefined;
  readonly lastAct: { cursor(): number | undefined };
  /** The newest action id this session minted. Events in an open action window carry it. */
  readonly lastActionId: string | undefined;
  eventsSince(cursor: number): ReticleEvent[];
}

/** The part of a `Session` that receives the record. A real `Session` satisfies it. */
export interface ArrivingSession {
  pushEvent(event: ReticleEvent): void;
  onEvent(listener: (event: ReticleEvent) => void): () => void;
}

/**
 * A request that failed with no HTTP status (status 0) in a document that then unloaded.
 *
 * A browser cancels the requests of a document it leaves, and the page sees that as a network
 * error ("Failed to fetch"). The server can have received the request and answered it: driven
 * against a POST that took 2 s to answer, the server logged the POST while the page recorded
 * status 0. So the status 0 is not the server's answer. The record is left out, and its pending
 * half is carried as `pageUnloaded`: unknown, not failed.
 */
function abortedByUnload(event: ReticleEvent): boolean {
  return event.type === EventType.NET_REQUEST && 0 === event.data['status'];
}

/**
 * Where the newest action's records start in the departed session, or undefined when no agent acted.
 *
 * Two sources, and the later one wins. `lastAct.cursor()` is set when an act's reply arrives. A
 * click that calls `location.assign()` can unload the page before that reply, so the cursor stays
 * at an OLDER act (or unset), and the request is left behind (driven: it was). The events of an
 * open action window carry its id, so the first event with the newest id marks where that action
 * began to have effects. The later of the two is the newest action, so older traffic stays out.
 */
function newestActionStart(session: DepartingSession): number | undefined {
  const cursor = session.lastAct.cursor();
  const id = session.lastActionId;
  const firstOfNewest =
    id === undefined ? undefined : session.eventsSince(0).find((e) => e.actionId === id)?.t;
  if (cursor === undefined) {
    return firstOfNewest;
  }
  if (firstOfNewest === undefined) {
    return cursor;
  }
  return Math.max(cursor, firstOfNewest);
}

/** One carried record: the loss is declared and the old document's coordinates are removed. */
function carried(event: ReticleEvent, unanswered: ReadonlySet<string>): ReticleEvent {
  const id = asString(event.data['id']);
  const lost =
    event.type === EventType.NET_PENDING && id !== undefined && unanswered.has(id)
      ? { [DepartedNetField.PAGE_UNLOADED]: true }
      : {};
  return {
    t: event.t,
    type: event.type,
    sessionId: event.sessionId,
    data: { ...event.data, [DepartedNetField.FROM_DEPARTED_DOCUMENT]: true, ...lost },
  };
}

/**
 * The network records the old document made after the agent's last act on it, ready to carry.
 * Undefined when nothing is to be carried.
 */
export function departedNetworkOf(session: DepartingSession): DepartedNetwork | undefined {
  const floor = newestActionStart(session);
  if (floor === undefined) {
    return undefined;
  }
  const window = session
    .eventsSince(floor)
    .filter(
      (e) =>
        CARRIED_TYPES.has(e.type) &&
        e.data['initiator'] !== NetInitiator.NAVIGATION &&
        !abortedByUnload(e),
    );
  if (0 === window.length) {
    return undefined;
  }
  const answered = new Set<string>();
  for (const e of window) {
    const id = asString(e.data['id']);
    if (e.type === EventType.NET_REQUEST && id !== undefined) {
      answered.add(id);
    }
  }
  const unanswered = new Set<string>();
  for (const e of window) {
    const id = asString(e.data['id']);
    if (e.type === EventType.NET_PENDING && id !== undefined && !answered.has(id)) {
      unanswered.add(id);
    }
  }
  return {
    documentId: session.currentDocumentId,
    events: window.map((e) => carried(e, unanswered)),
  };
}

/**
 * Give the new session the old document's record once it shows that it is a new document.
 *
 * Waits for the first event that carries a `documentId`. A different id means the old document
 * unloaded: the record goes in, right after that event. The same id means the same document
 * reconnected, and nothing goes in. An old document with no id cannot be told apart, so nothing
 * goes in then either. Returns a function that stops the wait.
 */
export function carryOnNewDocument(next: ArrivingSession, departed: DepartedNetwork): () => void {
  const stop = next.onEvent((event) => {
    if (event.documentId === undefined) {
      return;
    }
    stop();
    if (departed.documentId === undefined || event.documentId === departed.documentId) {
      return;
    }
    for (const record of departed.events) {
      next.pushEvent(record);
    }
  });
  return stop;
}
