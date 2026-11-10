/**
 * resolveServing(): an id-less call that only some sessions can serve (#1959).
 *
 * resolve() chooses by health and recency alone. In each case below it chooses TAB, the focused
 * tab, which cannot serve the call. These tests pin what resolveServing() does about that.
 */

import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { MessageKind, RETICLE_PROTOCOL_VERSION, type HelloMessage } from '@reticlehq/core';
import { Session } from './session.js';
import { SessionManager } from './session-manager.js';

const TAB = 'tab-1';
const LEASE_A = 'lease-a';
const LEASE_B = 'lease-b';

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

/** A connected session on a fixed clock, so resolve() scores it the same on every run. */
function sessionOf(id: string, focused: boolean): Session {
  const hello: HelloMessage = {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: id,
    url: 'http://localhost:5173/',
    title: id,
    adapters: [],
    hasCapabilities: false,
  };
  const session = new Session(hello, fakeSocket, () => 0);
  session.touch();
  session.applyHealth(false, focused);
  return session;
}

/** The focused TAB, and one unfocused session for each of `others`. */
function managerWith(...others: string[]): SessionManager {
  const sessions = new SessionManager();
  sessions.add(sessionOf(TAB, true));
  for (const id of others) {
    sessions.add(sessionOf(id, false));
  }
  return sessions;
}

/** A canServe that answers yes for the given ids only. */
function servedBy(...ids: string[]): (session: Session) => boolean {
  return (session) => ids.includes(session.id);
}

describe('SessionManager.resolveServing()', () => {
  it('chooses the one session that can serve, over the focused tab that cannot', async () => {
    const sessions = managerWith(LEASE_A);

    const chosen = await sessions.resolveServing(undefined, servedBy(LEASE_A));

    expect(chosen.id).toBe(LEASE_A);
  });

  it('awaits a canServe that asks a browser', async () => {
    const sessions = managerWith(LEASE_A);

    const chosen = await sessions.resolveServing(undefined, (s) =>
      Promise.resolve(s.id === LEASE_A),
    );

    expect(chosen.id).toBe(LEASE_A);
  });

  it('refuses and names the sessions that can serve, when the usual choice cannot', async () => {
    const sessions = managerWith(LEASE_A, LEASE_B);

    const call = sessions.resolveServing(undefined, servedBy(LEASE_A, LEASE_B));

    // Two can serve, so choosing one is a guess. The refusal names both, and not TAB.
    await expect(call).rejects.toThrow(`'${LEASE_A}', '${LEASE_B}'`);
    await expect(call).rejects.not.toThrow(`'${TAB}'`);
  });

  it('keeps the usual choice when it can serve', async () => {
    const sessions = managerWith(LEASE_A);

    const chosen = await sessions.resolveServing(undefined, servedBy(TAB, LEASE_A));

    expect(chosen.id).toBe(TAB);
  });

  it('returns the usual choice when none can serve, so the tool gives its own refusal', async () => {
    const sessions = managerWith(LEASE_A);

    const chosen = await sessions.resolveServing(undefined, servedBy());

    expect(chosen.id).toBe(TAB);
  });

  it('returns a named session, even one that cannot serve', async () => {
    const sessions = managerWith(LEASE_A);

    const chosen = await sessions.resolveServing(TAB, servedBy(LEASE_A));

    expect(chosen.id).toBe(TAB);
  });
});
