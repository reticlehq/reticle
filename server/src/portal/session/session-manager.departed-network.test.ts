/**
 * #1944: a click sends a POST and then loads a new document. The POST was not in the record.
 *
 * The old document sends its network events before it unloads, so the daemon has them. But the new
 * document connects as a NEW `Session` under the same id, and the act's verdict, every later
 * `reticle_observe { action: "network" }` and every later `reticle_assert` read only that session.
 * The old document's requests were dropped with the old `Session` object.
 *
 * The new session now gets the network records that the old document made after the agent's last
 * act. Each one says that it came from the document before. A request that had no answer before the
 * unload is marked `pageUnloaded`: its outcome is unknown, not absent.
 */

import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  DepartedNetField,
  EventType,
  MessageKind,
  NetInitiator,
  RETICLE_PROTOCOL_VERSION,
  ReticleTool,
  type HelloMessage,
  type ReticleEvent,
} from '@reticlehq/core';
import { Session } from './session.js';
import { SessionManager } from './session-manager.js';

const socket = { send: () => undefined, close: () => undefined } as unknown as WebSocket;
const TAB = 'tab-1';
const OLD_DOCUMENT = 'olddoc1';
const NEW_DOCUMENT = 'newdoc1';
const SIGN_OUT = '/api/sign-out';

function hello(): HelloMessage {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: TAB,
    url: 'http://localhost:3000/account',
    title: 'Account',
    adapters: [],
  };
}

function event(
  type: EventType,
  data: Record<string, unknown>,
  documentId = OLD_DOCUMENT,
): ReticleEvent {
  return { t: 0, seq: 7, type, sessionId: TAB, documentId, data };
}

const pending = (id: string, method: string, url: string, initiator: string): ReticleEvent =>
  event(EventType.NET_PENDING, { id, method, url, initiator });
const answered = (id: string): ReticleEvent =>
  event(EventType.NET_REQUEST, {
    id,
    method: 'POST',
    url: SIGN_OUT,
    status: 200,
    ok: true,
    durationMs: 4,
    initiator: NetInitiator.FETCH,
  });
const newDocumentLoad = (documentId = NEW_DOCUMENT): ReticleEvent =>
  event(
    EventType.NET_REQUEST,
    {
      id: 'doc-0',
      method: 'GET',
      url: 'http://localhost:3000/sign-in',
      status: 200,
      ok: true,
      durationMs: 1,
      initiator: NetInitiator.DOCUMENT,
    },
    documentId,
  );

interface Departure {
  /** Events the old document sent before the agent acted. */
  before?: ReticleEvent[];
  /** Events the old document sent after the agent acted. */
  after: ReticleEvent[];
  /** False when no agent ever acted on the old document. */
  acted?: boolean;
  /** False when the page unloaded before the act's reply arrived, so the act never marked. */
  replied?: boolean;
  /** True when an earlier, finished act marked the cursor before the `before` events. */
  olderAct?: boolean;
  /** True when the new document says hello before the old socket closes. */
  helloBeforeClose?: boolean;
}

/** The old document acts and unloads, and the new document connects under the same id. */
function departAndReturn(departure: Departure): { mgr: SessionManager; next: Session } {
  const clock = { t: 0 };
  const mgr = new SessionManager();
  const old = new Session(hello(), socket, () => clock.t);
  mgr.add(old);
  if (true === departure.olderAct) {
    old.beginAction(ReticleTool.ACT, {});
    old.lastAct.markActed(0, 'click', undefined);
    old.finishAction();
  }
  for (const e of departure.before ?? []) {
    old.pushEvent(e);
  }
  clock.t = 100;
  if (false !== departure.acted) {
    const since = old.elapsed();
    old.beginAction(ReticleTool.ACT_AND_WAIT, {});
    clock.t = 110;
    if (false !== departure.replied) {
      old.lastAct.markActed(since, 'click', undefined);
    }
  }
  for (const e of departure.after) {
    old.pushEvent(e);
  }
  clock.t = 200;
  const next = new Session(hello(), socket, () => clock.t);
  if (true === departure.helloBeforeClose) {
    mgr.add(next);
    mgr.remove(old);
  } else {
    mgr.remove(old);
    mgr.add(next);
  }
  return { mgr, next };
}

const signOutRecords = (session: Session): ReticleEvent[] =>
  session.eventsSince(0).filter((e) => e.data['url'] === SIGN_OUT);

describe('a request the old document made before a full page load (#1944)', () => {
  it('is in the new session, marked as from the document before', () => {
    const { next } = departAndReturn({
      after: [pending('n2', 'POST', SIGN_OUT, NetInitiator.FETCH), answered('n2')],
    });
    next.pushEvent(newDocumentLoad());
    const records = signOutRecords(next);
    expect(records.map((e) => e.type)).toEqual([EventType.NET_PENDING, EventType.NET_REQUEST]);
    for (const record of records) {
      expect(record.data[DepartedNetField.FROM_DEPARTED_DOCUMENT]).toBe(true);
      expect(record.data[DepartedNetField.PAGE_UNLOADED]).toBeUndefined();
    }
  });

  it('does not make the old document the current one again', () => {
    const { next } = departAndReturn({
      after: [pending('n2', 'POST', SIGN_OUT, NetInitiator.FETCH), answered('n2')],
    });
    next.pushEvent(newDocumentLoad());
    expect(next.currentDocumentId).toBe(NEW_DOCUMENT);
    for (const record of signOutRecords(next)) {
      expect(record.documentId).toBeUndefined();
      expect(record.seq).toBeUndefined();
    }
  });

  it('marks a request with no answer as page unloaded, so its outcome is unknown', () => {
    const { next } = departAndReturn({
      after: [pending('n2', 'POST', SIGN_OUT, NetInitiator.FETCH)],
    });
    next.pushEvent(newDocumentLoad());
    const [record] = signOutRecords(next);
    expect(record?.type).toBe(EventType.NET_PENDING);
    expect(record?.data[DepartedNetField.PAGE_UNLOADED]).toBe(true);
  });

  // location.assign() can unload the page before the act's reply comes back. Driven: the POST was
  // in the old session, and the act had never marked its cursor.
  it('is carried when the page unloaded before the act replied', () => {
    const { next } = departAndReturn({
      before: [pending('n1', 'POST', SIGN_OUT, NetInitiator.FETCH), answered('n1')],
      after: [pending('n2', 'POST', SIGN_OUT, NetInitiator.FETCH), answered('n2')],
      replied: false,
      olderAct: true,
    });
    next.pushEvent(newDocumentLoad());
    // The newest action's request, and not the one an older act left in the old document.
    expect(signOutRecords(next).map((e) => e.data['id'])).toEqual(['n2', 'n2']);
  });

  // Driven against a POST that took 2 s: the server logged it, and the page recorded status 0
  // ("Failed to fetch") because the browser cancelled it on the way out.
  it('carries a status 0 failure as page unloaded, not as a failed request', () => {
    const aborted = event(EventType.NET_REQUEST, {
      id: 'n2',
      method: 'POST',
      url: SIGN_OUT,
      status: 0,
      ok: false,
      error: 'Failed to fetch',
      durationMs: 103,
      initiator: NetInitiator.FETCH,
    });
    const { next } = departAndReturn({
      after: [pending('n2', 'POST', SIGN_OUT, NetInitiator.FETCH), aborted],
    });
    next.pushEvent(newDocumentLoad());
    const records = signOutRecords(next);
    expect(records.map((e) => e.type)).toEqual([EventType.NET_PENDING]);
    expect(records[0]?.data[DepartedNetField.PAGE_UNLOADED]).toBe(true);
  });

  it('is carried when the new document says hello before the old socket closes', () => {
    const { next } = departAndReturn({
      after: [pending('n2', 'POST', SIGN_OUT, NetInitiator.FETCH), answered('n2')],
      helloBeforeClose: true,
    });
    next.pushEvent(newDocumentLoad());
    expect(signOutRecords(next)).toHaveLength(2);
  });

  it('leaves out the departure record: the new document records its own load', () => {
    const { next } = departAndReturn({
      after: [pending('nav-1', 'GET', 'http://localhost:3000/sign-in', NetInitiator.NAVIGATION)],
    });
    next.pushEvent(newDocumentLoad());
    expect(next.eventsSince(0).filter((e) => e.type === EventType.NET_PENDING)).toEqual([]);
  });

  it('leaves out requests from before the last act', () => {
    const { next } = departAndReturn({
      before: [pending('n1', 'POST', SIGN_OUT, NetInitiator.FETCH), answered('n1')],
      after: [],
    });
    next.pushEvent(newDocumentLoad());
    expect(signOutRecords(next)).toEqual([]);
  });

  it('carries nothing when no agent acted on the old document', () => {
    const { next } = departAndReturn({
      after: [pending('n2', 'POST', SIGN_OUT, NetInitiator.FETCH), answered('n2')],
      acted: false,
    });
    next.pushEvent(newDocumentLoad());
    expect(signOutRecords(next)).toEqual([]);
  });

  it('carries nothing when the same document reconnects: nothing unloaded', () => {
    const { next } = departAndReturn({
      after: [pending('n2', 'POST', SIGN_OUT, NetInitiator.FETCH)],
    });
    next.pushEvent(newDocumentLoad(OLD_DOCUMENT));
    expect(signOutRecords(next)).toEqual([]);
  });
});
