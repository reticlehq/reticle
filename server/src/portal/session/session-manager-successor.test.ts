/**
 * A dead sessionId after a full-document navigation used to be a dead end.
 *
 * The agent still holds the id of the page that just unloaded. The new page has already HELLO'd,
 * often under a new id. `resolve` now follows the unique same-origin successor instead of refusing
 * — which is how `assert` after `act_and_wait` on an MPA link starts working. An id that was never
 * seen still refuses, and two live tabs at that origin still refuse: those are guesses.
 */

import { describe, it, expect } from 'vitest';
import type { WebSocket } from 'ws';
import { RETICLE_PROTOCOL_VERSION, MessageKind, type HelloMessage } from '@reticlehq/core';
import { Session } from './session.js';
import { SessionManager } from './session-manager.js';

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

function hello(id: string, url: string, projectId?: string): HelloMessage {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: id,
    url,
    title: id,
    adapters: [],
    hasCapabilities: false,
    ...(projectId === undefined ? {} : { projectId }),
  };
}

function session(id: string, url: string, projectId?: string): Session {
  return new Session(hello(id, url, projectId), fakeSocket, () => 0);
}

/**
 * #983, driven: two tabs of one project, the agent clicks a full-navigation link in tab A with A's
 * explicit id, and the verdict came back graded on tab B. B was the "unique" live session at the
 * origin only because A's own document had not come back yet. A tab that was already open before the
 * agent last drove A cannot be the document A's navigation produced.
 */
describe('a successor arrives after the departure, it is never a tab that was already open', () => {
  const at = (start: { t: number }) => (): number => start.t;

  it('does not rebind a departed tab to a sibling that was open before the agent drove it', () => {
    const clock = { t: 0 };
    const mgr = new SessionManager();
    const a = new Session(
      hello('a', 'http://localhost:3000/?tab=A', 'shop'),
      fakeSocket,
      at(clock),
    );
    clock.t = 500;
    const b = new Session(
      hello('b', 'http://localhost:3000/?tab=B', 'shop'),
      fakeSocket,
      at(clock),
    );
    mgr.add(a);
    mgr.add(b);
    clock.t = 60_000;
    a.markAgentActivity(); // the click that navigates A
    clock.t = 60_010;
    mgr.remove(a); // A's document unloads
    expect(() => mgr.resolve('a')).toThrow();
  });

  it('still rebinds to the new document that arrived after the click, beside that sibling', () => {
    const clock = { t: 0 };
    const mgr = new SessionManager();
    const a = new Session(
      hello('a', 'http://localhost:3000/?tab=A', 'shop'),
      fakeSocket,
      at(clock),
    );
    const b = new Session(
      hello('b', 'http://localhost:3000/?tab=B', 'shop'),
      fakeSocket,
      at(clock),
    );
    mgr.add(a);
    mgr.add(b);
    clock.t = 60_000;
    a.markAgentActivity();
    clock.t = 60_010;
    mgr.remove(a);
    clock.t = 60_300;
    mgr.add(
      new Session(
        hello('a2', 'http://localhost:3000/?tab=A&step=3', 'shop'),
        fakeSocket,
        at(clock),
      ),
    );
    expect(mgr.resolve('a').id).toBe('a2');
  });
});

describe('resolve follows a unique same-origin successor', () => {
  it('rebinds the departed id to the one live session at that origin', () => {
    const mgr = new SessionManager();
    const old = session('old', 'http://localhost:3000/orders', 'shop');
    mgr.add(old);
    mgr.remove(old);
    const next = session('new', 'http://localhost:3000/orders/42', 'shop');
    mgr.add(next);

    expect(mgr.resolve('old').id).toBe('new');
  });

  it('does not rebind an id that was never connected', () => {
    const mgr = new SessionManager();
    mgr.add(session('live', 'http://localhost:3000/', 'shop'));
    expect(() => mgr.resolve('ghost')).toThrow(/ghost/);
  });

  it('does not guess when two tabs share the origin', () => {
    const mgr = new SessionManager();
    const old = session('old', 'http://localhost:3000/a', 'shop');
    mgr.add(old);
    mgr.remove(old);
    mgr.add(session('a', 'http://localhost:3000/a', 'shop'));
    mgr.add(session('b', 'http://localhost:3000/b', 'shop'));
    expect(() => mgr.resolve('old')).toThrow(/old/);
  });

  it('does not rebind across origins', () => {
    const mgr = new SessionManager();
    const old = session('old', 'http://localhost:3000/a', 'shop');
    mgr.add(old);
    mgr.remove(old);
    mgr.add(session('other', 'http://localhost:9999/a', 'shop'));
    expect(() => mgr.resolve('old')).toThrow(/old/);
  });
});

/**
 * When the page is torn down and nothing HELLO's back, the tombstone is the last thing we knew.
 * `reticle_sessions` and the no-session diagnosis read this so an empty list is not a dead end (#808).
 */
describe('lastKnown remembers the departed tab', () => {
  it('is undefined until a session has connected and left', () => {
    expect(new SessionManager().lastKnown()).toBeUndefined();
  });

  it('names the id and URL of the session that just disappeared', () => {
    const mgr = new SessionManager();
    const old = session('torn', 'http://localhost:3000/orders/explode', 'shop');
    mgr.add(old);
    expect(mgr.lastKnown()).toBeUndefined();
    mgr.remove(old);
    expect(mgr.lastKnown()).toEqual({
      id: 'torn',
      url: 'http://localhost:3000/orders/explode',
      projectId: 'shop',
    });
  });

  it('a vanished id with no live successor names the last URL rather than only the missing id', () => {
    const mgr = new SessionManager();
    const old = session('torn', 'http://localhost:3000/orders/explode', 'shop');
    mgr.add(old);
    mgr.remove(old);
    expect(() => mgr.resolve('torn')).toThrow(/orders\/explode/);
  });
});
