/**
 * Project-scoped session resolution — the anti-cross-talk guard.
 *
 * Proves that when several apps are connected to one bridge, auto-selection scopes to the agent's
 * active project (by stable projectId, or origin as a fallback) so a stray tab from another app is
 * structurally unselectable. Covers the dev "port swap" case the design hinges on: a projectId
 * survives its app booting on a different port than usual.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RETICLE_WS_PATH, LOOPBACK_HOST, MessageKind } from '@reticlehq/core';
import { Bridge } from '../bridge/bridge.js';

let bridge: Bridge;
let port: number;
const open: WebSocket[] = [];

beforeEach(async () => {
  bridge = new Bridge({ port: 0 });
  port = await bridge.ready;
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.close();
  await bridge.close();
});

/** Connect a raw session announcing a sessionId, url, and (optionally) a stable projectId. */
function connect(opts: { sessionId: string; url: string; projectId?: string }): Promise<void> {
  return new Promise((resolve) => {
    const sock = new WebSocket(`ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`, {
      origin: 'http://localhost',
    });
    open.push(sock);
    sock.on('open', () => {
      sock.send(
        JSON.stringify({
          kind: MessageKind.HELLO,
          protocolVersion: 1,
          sessionId: opts.sessionId,
          ...(opts.projectId === undefined ? {} : { projectId: opts.projectId }),
          url: opts.url,
          title: opts.sessionId,
          adapters: [],
          hasCapabilities: false,
        }),
      );
      sock.on('message', () => undefined);
      resolve();
    });
  });
}

async function waitForSessions(n: number): Promise<void> {
  for (let i = 0; i < 100 && bridge.sessions.count() < n; i++) {
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

describe('project-scoped resolve()', () => {
  it('two apps on the same origin, different projectId → scope picks the right one', async () => {
    await connect({ sessionId: 'tab-a', url: 'http://localhost:3000/', projectId: 'app-a' });
    await connect({ sessionId: 'tab-b', url: 'http://localhost:3000/', projectId: 'app-b' });
    await waitForSessions(2);

    expect(bridge.sessions.resolve(undefined, { projectId: 'app-a' }).id).toBe('tab-a');
    expect(bridge.sessions.resolve(undefined, { projectId: 'app-b' }).id).toBe('tab-b');
  });

  it('port swap: projectId is stable, so scoping ignores which port the app booted on', async () => {
    // app-a normally lives on:3000 but today grabbed:3001; app-b took:3000.
    await connect({ sessionId: 'a', url: 'http://localhost:3001/', projectId: 'app-a' });
    await connect({ sessionId: 'b', url: 'http://localhost:3000/', projectId: 'app-b' });
    await waitForSessions(2);

    // Scoping by projectId picks app-a even though it's on the "wrong" port.
    expect(bridge.sessions.resolve(undefined, { projectId: 'app-a' }).id).toBe('a');
  });

  it('a stray tab from another project is never auto-selected', async () => {
    await connect({ sessionId: 'mine', url: 'http://localhost:3000/', projectId: 'mine' });
    // A leftover dashboard on a different port, connected to the same bridge.
    await connect({ sessionId: 'stray', url: 'http://localhost:4310/', projectId: 'showcase' });
    await waitForSessions(2);

    expect(bridge.sessions.resolve(undefined, { projectId: 'mine' }).id).toBe('mine');
  });

  it('sessions exist but none match the scope → honest scoped error, no foreign fallback', async () => {
    await connect({ sessionId: 'stray', url: 'http://localhost:4310/', projectId: 'showcase' });
    await waitForSessions(1);

    expect(() => bridge.sessions.resolve(undefined, { projectId: 'ghost' })).toThrow(/ghost/);
  });

  /**
   * The refusal used to ask "is that app running with @reticlehq/core enabled?" — the ONE thing that
   * is definitely true, since the connected session is sitting right there in reticle_sessions. The
   * reader then goes looking at their app instead of at the scope. It cost ~20 minutes with the
   * source open. What is connected, and how to target it, is in hand at the point of failure.
   */
  it('names the sessions that ARE connected, and how to target one', async () => {
    await connect({ sessionId: 'stray', url: 'http://localhost:4310/', projectId: 'showcase' });
    await waitForSessions(1);

    let message = '';
    try {
      bridge.sessions.resolve(undefined, { projectId: 'ghost' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('ghost'); // the scope that found nothing
    expect(message).toContain('showcase'); // the project that IS connected
    expect(message).toContain('stray'); // the sessionId to pass
    expect(message).toContain('http://localhost:4310/'); // where it came from
    expect(message).not.toContain('is that app running');
  });

  it('origin scope works for legacy SDKs that send no projectId', async () => {
    await connect({ sessionId: 'next', url: 'http://localhost:3000/' });
    await connect({ sessionId: 'vite', url: 'http://localhost:5173/' });
    await waitForSessions(2);

    expect(bridge.sessions.resolve(undefined, { url: 'http://localhost:5173/dashboard' }).id).toBe(
      'vite',
    );
  });

  it('no scope → legacy behavior unchanged (single session resolves)', async () => {
    await connect({ sessionId: 'solo', url: 'http://localhost:3000/' });
    await waitForSessions(1);

    expect(bridge.sessions.resolve().id).toBe('solo');
  });

  it('a default scope (from .reticle.json) is applied when no per-call scope is given', async () => {
    bridge.sessions.setDefaultScope({ projectId: 'mine' });
    await connect({ sessionId: 'mine-tab', url: 'http://localhost:3000/', projectId: 'mine' });
    await connect({ sessionId: 'stray', url: 'http://localhost:4310/', projectId: 'showcase' });
    await waitForSessions(2);

    // No explicit scope → the default project scope picks the right tab, not the stray one.
    expect(bridge.sessions.resolve().id).toBe('mine-tab');
    // A foreign default scope with no matching session throws (never grabs the stray).
    bridge.sessions.setDefaultScope({ projectId: 'ghost' });
    expect(() => bridge.sessions.resolve()).toThrow(/ghost/);
    // An explicit per-call scope still overrides the default.
    expect(bridge.sessions.resolve(undefined, { projectId: 'showcase' }).id).toBe('stray');
  });
});

/**
 * A dead `sessionId` used to be a dead end, and the telemetry shows what that costs.
 *
 * On 2026-08-10 one agent called `reticle_navigate` twelve times against a sessionId that was no
 * longer connected — **12 of the 58 tool errors recorded that whole day, 21%, from one loop.** The
 * message it got each time was `no connected session with id 'x'`, and the attached recovery hint
 * said "Call reticle_sessions for the current ids and retry with a valid one". The agent never did.
 *
 * The daemon already knows the live ids at the moment it refuses. Making the agent spend a round
 * trip to learn something the refusal could have told it is the defect: an agent that has to make
 * two extra calls to recover will often just retry the one it made.
 */
describe('a dead sessionId names the live ones instead of sending the agent away', () => {
  it('names the connected sessions in the error', async () => {
    await connect({ sessionId: 'alive-1', url: 'http://localhost:3000/', projectId: 'p' });
    await connect({ sessionId: 'alive-2', url: 'http://localhost:3001/', projectId: 'p' });
    await waitForSessions(2);

    let message = '';
    try {
      bridge.sessions.resolve('ghost');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('ghost');
    expect(message, 'the refusal must name the live sessions — the daemon knows them').toContain(
      'alive-1',
    );
    expect(message).toContain('alive-2');
  });

  it('when nothing is connected at all, it says so rather than implying a retry would help', () => {
    let message = '';
    try {
      bridge.sessions.resolve('ghost');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('ghost');
    expect(
      message,
      'with zero sessions, "retry with a valid one" is advice the agent cannot act on',
    ).toMatch(/no sessions are connected/i);
  });
});
