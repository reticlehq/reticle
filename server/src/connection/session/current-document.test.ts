import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  RETICLE_PROTOCOL_VERSION,
  MessageKind,
  EventType,
  type HelloMessage,
  type ReticleEvent,
} from '@reticlehq/core';
import { Session } from './session.js';

/**
 * The session's view of WHICH document is on screen — derived from the stream it already receives,
 * never announced separately. A full navigation replaces the document, the SDK mints a new id, and
 * the first event stamped with it moves the session forward.
 */

const HELLO: HelloMessage = {
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 'demo',
  url: 'http://localhost/',
  title: 'Demo',
  adapters: [],
  hasCapabilities: false,
};

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

function makeSession(): Session {
  return new Session(HELLO, fakeSocket, () => 0);
}

const stamped = (documentId?: string): ReticleEvent => {
  const base: ReticleEvent = { t: 0, type: EventType.DOM_TEXT, sessionId: 'demo', data: {} };
  return documentId === undefined ? base : { ...base, documentId };
};

describe('Session.currentDocumentId', () => {
  it('is unknown until the first stamped event arrives', () => {
    expect(makeSession().currentDocumentId).toBeUndefined();
  });

  it('takes the document of the most recent stamped event', () => {
    const session = makeSession();
    session.pushEvent(stamped('doc-a'));
    expect(session.currentDocumentId).toBe('doc-a');
  });

  it('moves when a full navigation replaces the document', () => {
    const session = makeSession();
    session.pushEvent(stamped('doc-a'));
    session.pushEvent(stamped('doc-b'));
    expect(session.currentDocumentId).toBe('doc-b');
  });

  it('is not erased by an unstamped event from an older SDK', () => {
    const session = makeSession();
    session.pushEvent(stamped('doc-a'));
    session.pushEvent(stamped());
    expect(session.currentDocumentId).toBe('doc-a');
  });
});
