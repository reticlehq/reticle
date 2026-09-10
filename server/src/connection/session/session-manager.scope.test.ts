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

/**
 * The listing carries continuity, so an agent can tell a session that never dropped from one that
 * did. Driven over the real bridge rather than the pure class, because the value of this is that
 * `add`/`remove` are wired to it — the arithmetic is already covered in attachment-history.test.ts.
 */
describe('reticle_sessions reports whether a session stayed attached', () => {
  it('a freshly connected session reports zero outages', async () => {
    await connect({ sessionId: 'fresh', url: 'http://localhost:3000/', projectId: 'p' });
    await waitForSessions(1);
    const [info] = bridge.sessions.list();
    expect(
      info?.attachment,
      'the listing cannot answer "was it attached the whole time"',
    ).toBeDefined();
    expect(info?.attachment?.outages).toBe(0);
  });

  it('exposes continuity per session id', async () => {
    await connect({ sessionId: 'a', url: 'http://localhost:3000/', projectId: 'p' });
    await waitForSessions(1);
    expect(bridge.sessions.attachmentOf('a')?.outages).toBe(0);
    expect(bridge.sessions.attachmentOf('never-seen')).toBeUndefined();
  });
});

/**
 * Two apps under one repo root, one daemon, no scope — a call for one was answered by the other.
 *
 * Reported from the field:
 *
 * > A call from an MCP client whose cwd is `apps/next-app-router` was resolved against a session
 * > whose projectId is `rowy-d30b4137` — a different app. `reticle_act_and_wait` then spent 16.9s
 * > and returned `verified:'no'`, `pass:false`, "no route change observed" **about an app never
 * > under test**.
 *
 * That is the worst shape of bug this product can ship: a confident false verdict, with a source
 * pointer, about code the agent never touched. Every honesty rule in `decideVerified` exists to
 * prevent exactly that, and none fire — from the daemon's point of view nothing went wrong.
 *
 * The cause is upstream of all of them. The default scope is `readProjectId(process.cwd())` — the
 * DAEMON's cwd (`index.ts:388`). Start the daemon at a repo root above two apps and there is no
 * `.reticle.json` there, so there is no scope at all, and auto-selection falls through to picking
 * the freshest heartbeat. The existing ambiguity check compares RECENCY; it has no opinion about
 * two tabs belonging to different projects.
 *
 * So: when nothing has scoped the call and the candidates span more than one project, refuse and
 * name them. A refusal costs the agent one argument. A false verdict costs it an afternoon editing
 * the wrong file.
 */
describe('an unscoped call across two projects refuses instead of guessing', () => {
  it('refuses when two projects are connected and nothing disambiguates', async () => {
    await connect({ sessionId: 'a', url: 'http://localhost:3000/', projectId: 'next-app-router' });
    await connect({ sessionId: 'b', url: 'http://localhost:7699/', projectId: 'rowy-d30b4137' });
    await waitForSessions(2);

    let message = '';
    try {
      bridge.sessions.resolve();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, 'it picked one of two apps by heartbeat freshness').not.toBe('');
    expect(message, 'the agent cannot choose without being told what the options are').toContain(
      'next-app-router',
    );
    expect(message).toContain('rowy-d30b4137');
  });

  it('still auto-selects when both sessions belong to the SAME project', async () => {
    // Two tabs of one app is not ambiguity about WHICH APP — the existing recency rule handles it.
    await connect({ sessionId: 'one', url: 'http://localhost:3000/a', projectId: 'same' });
    await waitForSessions(1);
    expect(bridge.sessions.resolve().id).toBe('one');
  });

  it('an explicit scope still wins, so nothing that already worked changes', async () => {
    await connect({ sessionId: 'a', url: 'http://localhost:3000/', projectId: 'app-a' });
    await connect({ sessionId: 'b', url: 'http://localhost:3001/', projectId: 'app-b' });
    await waitForSessions(2);
    expect(bridge.sessions.resolve(undefined, { projectId: 'app-b' }).id).toBe('b');
  });

  it('an explicit sessionId still wins', async () => {
    await connect({ sessionId: 'a', url: 'http://localhost:3000/', projectId: 'app-a' });
    await connect({ sessionId: 'b', url: 'http://localhost:3001/', projectId: 'app-b' });
    await waitForSessions(2);
    expect(bridge.sessions.resolve('b').id).toBe('b');
  });
});
