/**
 * A refusal the bridge is doing NOW, told apart from one the daemon merely remembers.
 *
 * `lastClosure` records only the closes the BRIDGE initiated — an auth failure, a handshake refusal
 * — so an ordinary disconnect never reaches it. Read on its own it answers "what is the last thing
 * the bridge hung up on, ever", which is not the question the no-session diagnosis asks. A refusal
 * at 10:00, a good session at 10:05 and a closed tab at 10:10 leaves it still reading `AUTH_FAILED`,
 * and the diagnosis then blames the pairing token for a tab the human closed.
 *
 * That matters because the refusal now OUTRANKS `everConnected` in `nextActionFor`: without the
 * ordering fact below, the fix for "reopen the tab, forever, while every page is refused on a
 * rotated token" would simply have been that bug's mirror image.
 */

import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/core';
import { WS_CLOSE_REASON } from '../bridge/bridge.js';
import { Session } from './session.js';
import { SessionManager } from './session-manager.js';

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

function session(id: string): Session {
  const hello: HelloMessage = {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: id,
    url: 'http://localhost:5173/',
    title: id,
    adapters: [],
    hasCapabilities: false,
  };
  return new Session(hello, fakeSocket, () => 0);
}

describe('a refusal is current only while nothing has connected after it', () => {
  it('reports nothing connected after a refusal, which is the live case', () => {
    const mgr = new SessionManager();
    mgr.noteClosure(WS_CLOSE_REASON.AUTH_FAILED, 1000);

    expect(mgr.lastClosure()?.reason).toBe(WS_CLOSE_REASON.AUTH_FAILED);
    expect(mgr.connectedSinceLastClosure()).toBe(false);
  });

  it('stops reporting it once a session gets in, even though the closure is still recorded', () => {
    // The sequence that made the old ordering right and makes the raw `lastClosure` read wrong.
    const mgr = new SessionManager();
    mgr.noteClosure(WS_CLOSE_REASON.AUTH_FAILED, 1000);
    mgr.add(session('after-the-refusal'));

    // Still remembered — other readers explain a session that vanished, and that history is theirs.
    expect(mgr.lastClosure()?.reason).toBe(WS_CLOSE_REASON.AUTH_FAILED);
    // But no longer the current state of the bridge.
    expect(mgr.connectedSinceLastClosure()).toBe(true);
  });

  it('goes back to current when a page is refused again after that session', () => {
    const mgr = new SessionManager();
    mgr.noteClosure(WS_CLOSE_REASON.AUTH_FAILED, 1000);
    mgr.add(session('good'));
    mgr.noteClosure(WS_CLOSE_REASON.AUTH_FAILED, 3000);

    expect(mgr.connectedSinceLastClosure()).toBe(false);
  });

  it('is false on a daemon nothing has ever closed, so it cannot be read as evidence on its own', () => {
    // Deliberate: the flag answers "after the last closure" and there is no last closure. Every
    // reader pairs it with `lastClosure()`, and one that did not would be asking the wrong question.
    expect(new SessionManager().connectedSinceLastClosure()).toBe(false);
  });

  it('does not confuse an ordinary disconnect with a bridge-initiated close', () => {
    // `remove` is not a closure: the whole hazard is that the ring does not see ordinary departures,
    // so a tab that opens and closes normally must leave the refusal exactly as it found it.
    const mgr = new SessionManager();
    mgr.noteClosure(WS_CLOSE_REASON.AUTH_FAILED, 1000);
    const tab = session('opened-then-closed');
    mgr.add(tab);
    mgr.remove(tab);

    expect(mgr.connectedSinceLastClosure()).toBe(true);
  });
});
