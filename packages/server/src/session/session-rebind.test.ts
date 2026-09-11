import { describe, it, expect, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  MessageKind,
  ReticleCommand,
  RETICLE_PROTOCOL_VERSION,
  type HelloMessage,
} from '@reticlehq/core';
import { Session } from './session.js';

/**
 * A page that re-dials under the same session id used to kill every tool call holding the old
 * transport.
 *
 * Reported five times by three users on two clients, always the same shape: `reticle_navigate`
 * succeeds, the page reloads and sends a fresh HELLO carrying the id it already had, the bridge
 * disconnects the displaced session, and the `reticle_snapshot` that was already on the wire dies
 * with "session replaced by a newer connection claiming the same id". The replacement itself is
 * correct — the page really did re-dial — but the caller is handed an error whose only answer is to
 * call `reticle_sessions` and retry, to learn an id the daemon is already holding and which has not
 * even changed.
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

const REPLACED = 'session replaced by a newer connection claiming the same id (demo)';

interface Wired {
  session: Session;
  /** Reply to the command the session most recently put on the wire. */
  reply: (result: unknown) => void;
  sent: string[];
}

function wire(readyState = 1): Wired {
  const sent: string[] = [];
  // `readyState: 1` is OPEN, and it is load-bearing rather than decoration: delegation to a
  // successor is gated on its socket still being open, so a fake that omits it models a CLOSED
  // connection and no rebinding can happen. A fake standing in for a live tab has to say it is live.
  const socket = {
    readyState,
    send: (payload: string): void => {
      sent.push(payload);
    },
    close: (): void => {},
  } as unknown as WebSocket;
  const session = new Session(HELLO, socket, () => 0);
  return {
    session,
    sent,
    reply: (result: unknown): void => {
      const last = sent[sent.length - 1];
      if (last === undefined) throw new Error('nothing was sent');
      const { id } = JSON.parse(last) as { id: string };
      session.handleResult({ kind: MessageKind.COMMAND_RESULT, id, ok: true, result });
    },
  };
}

describe('a session replaced under the same id rebinds instead of erroring', () => {
  it('finishes an in-flight read against the connection that replaced it', async () => {
    const old = wire();
    const fresh = wire();
    const pending = old.session.command(ReticleCommand.SNAPSHOT);
    old.session.succeededBy(fresh.session);
    old.session.disconnect(REPLACED);
    // The rebind rides the rejected command's promise chain, so it lands a few microtasks later.
    await vi.waitFor(() => expect(fresh.sent).toHaveLength(1));
    fresh.reply({ tree: 'after reload' });
    await expect(pending).resolves.toMatchObject({ result: { tree: 'after reload' } });
  });

  it('sends a later command straight to the successor', async () => {
    const old = wire();
    const fresh = wire();
    old.session.succeededBy(fresh.session);
    old.session.disconnect(REPLACED);
    const pending = old.session.command(ReticleCommand.QUERY);
    expect(old.sent).toHaveLength(0);
    expect(fresh.sent).toHaveLength(1);
    fresh.reply({ elements: [] });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  /**
   * The safety boundary. A read can be re-issued because re-reading a page costs nothing and answers
   * the same question. An act cannot: it may already have been dispatched in the page that went
   * away, and silently performing it a second time is a double submit nobody asked for. The honest
   * answer there is still the error — the caller's own retry, with the same id, is the safe path.
   */
  it('does not re-issue an act that was already on the wire', async () => {
    const old = wire();
    const fresh = wire();
    const pending = old.session.command(ReticleCommand.ACT, { ref: 'e1' });
    old.session.succeededBy(fresh.session);
    old.session.disconnect(REPLACED);
    await expect(pending).rejects.toThrow(/replaced by a newer connection/);
    expect(fresh.sent).toHaveLength(0);
  });

  it('still rejects an in-flight read when nothing replaced the session', async () => {
    const old = wire();
    const pending = old.session.command(ReticleCommand.SNAPSHOT);
    old.session.disconnect('session disconnected');
    await expect(pending).rejects.toThrow(/session disconnected/);
  });
});

/**
 * Delegating to a replacement that has itself gone away costs the caller MORE than the error did.
 *
 * A successor is recorded once and never cleared, so a session replaced long ago still holds a
 * reference to one. Without a liveness check the command is handed to a closed socket and the caller
 * waits out the whole timeout to learn what the "session replaced" error would have told them
 * immediately — the opposite of the round trip this path exists to save.
 */
describe('a successor that is no longer live', () => {
  it('is not delegated to — the error stands instead of a wait', async () => {
    const old = wire();
    const dead = wire(3); // 3 is CLOSED
    old.session.succeededBy(dead.session);

    const call = old.session.command(ReticleCommand.SNAPSHOT, {}, 50);
    old.session.rejectAll('session replaced by a newer connection claiming the same id');

    await expect(call).rejects.toThrow(/session replaced/);
    expect(dead.sent, 'nothing should reach a closed socket').toHaveLength(0);
  });

  it('does not send a later command to it either', async () => {
    const old = wire();
    const dead = wire(3);
    old.session.succeededBy(dead.session);

    const call = old.session.command(ReticleCommand.SNAPSHOT, {}, 50);
    // It went to the OLD session's own wire rather than the dead successor's.
    expect(old.sent).toHaveLength(1);
    expect(dead.sent).toHaveLength(0);
    old.reply({ ok: true });
    await call;
  });
});

/**
 * A command that TIMED OUT must not be re-issued, even though a successor exists.
 *
 * The rebinding catch fired on any rejection, so a plain timeout was read as "you were replaced,
 * try again" — and against a page re-dialling in a loop that turned ONE snapshot into hundreds of
 * commands on the wire, minutes of wall clock, and a final answer claiming the budget it had blown
 * by an order of magnitude. Measured under a reconnect storm before this guard existed.
 *
 * The two failures mean opposite things. A rejection from the replacement says the transport died
 * and the question was never asked — worth asking again. A timeout says the page WAS asked and did
 * not answer in the budget the caller set, and asking again spends a budget that is already gone.
 */
describe('a timed-out command is not retried into a successor', () => {
  it('reports the timeout instead of re-issuing', async () => {
    const old = wire();
    const next = wire();

    // In flight FIRST, then replaced — which is the real sequence, and the only one that reaches the
    // rebinding catch. Naming a successor before the call takes the pre-send path instead, where
    // delegating is correct because nothing has been sent yet.
    const call = old.session.command(ReticleCommand.SNAPSHOT, {}, 20);
    expect(old.sent, 'it went out on the original wire').toHaveLength(1);
    old.session.succeededBy(next.session);

    // Nobody ever replies, so the only way out is the timeout.
    await expect(call).rejects.toThrow(/timed out/);
    expect(next.sent, 'a spent budget must not be spent again').toHaveLength(0);
  });
});

/**
 * Two replacements in quick succession — a page that reloads twice — leaves a CHAIN: the handle the
 * caller holds points at a session that is itself already displaced.
 *
 * Stopping at the first dead link fails safe, and it also fails: the live page is one hop further on,
 * and the caller gets the error the rebinding exists to remove. A double reload is not exotic, and it
 * is precisely the shape the reports described.
 *
 * Walked rather than recursed, and bounded, because `succeededBy` refuses self-succession but nothing
 * prevents a cycle — and an unbounded walk over a cycle is a hang, which is worse than the error.
 */
describe('a chain of replacements', () => {
  it('finds the live session past a dead middle link', async () => {
    const first = wire();
    const middle = wire(3); // CLOSED — displaced in turn
    const live = wire();
    first.session.succeededBy(middle.session);
    middle.session.succeededBy(live.session);

    const call = first.session.command(ReticleCommand.SNAPSHOT, {}, 1000);
    expect(live.sent, 'it should reach the page that is actually open').toHaveLength(1);
    expect(first.sent, 'and not go out on the displaced wire').toHaveLength(0);
    live.reply({ ok: true });
    await call;
  });

  it('does not hang on a cycle', async () => {
    const a = wire(3);
    const b = wire(3);
    a.session.succeededBy(b.session);
    b.session.succeededBy(a.session);
    // Both dead and pointing at each other: the walk must terminate and the call must still answer.
    const call = a.session.command(ReticleCommand.SNAPSHOT, {}, 30);
    await expect(call).rejects.toThrow();
  });
});
