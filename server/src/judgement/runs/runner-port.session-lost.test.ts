/**
 * #2060: `reticle verify` must see that a flow left the app on a page with no session, say the URL
 * of that page, and open the app again for the next flow. This is the live port's half: it reads the
 * session and the driven page. ReticleRunner decides what the run reports.
 */
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { createRunnerPort } from '@/judgement/runs/runner-port.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { fakeHello } from '@/portal/session/fake-session.js';
import { Session } from '@/portal/session/session.js';
import { SessionManager } from '@/portal/session/session-manager.js';

const START = 'http://localhost:3000/';
const DEAD = 'http://localhost:3000/stats?id=missing';
/** Each read of the clock moves it one second, so a wait for a session ends after a few polls. */
const CLOCK_STEP_MS = 1000;

/**
 * A fake app. `reopenLoads` says if the page loads again. The session of a reloaded page connects
 * only later, as on a dev server that compiles the start page for a long time (#2155).
 */
function app(connected: boolean, reopenLoads: boolean) {
  const state = { connected, reopens: 0, resolves: 0 };
  let t = 0;
  const live = (): object[] => (state.connected ? [{ id: 'driven', url: START }] : []);
  const deps = {
    sessions: {
      // resolve() marks agent activity on the session it returns. A check that polls must not.
      resolve: () => {
        state.resolves += 1;
        throw new Error('no browser session connected');
      },
      inScope: live,
      count: () => live().length,
      get: () => live()[0],
      successorId: () => undefined,
    },
    realInput: {
      isAvailableFor: () => Promise.resolve(true),
      pageUrl: () => (state.connected ? START : DEAD),
      reopen: () => {
        state.reopens += 1;
        return Promise.resolve(reopenLoads);
      },
    },
    now: () => (t += CLOCK_STEP_MS),
  } as unknown as ToolDeps;
  return { deps, state };
}

describe('the live port after a flow (#2060)', () => {
  it('reports no loss while a session is connected', async () => {
    const { deps } = app(true, true);
    await expect(createRunnerPort(deps).sessionLost?.()).resolves.toBeUndefined();
  });

  it('names the URL of the driven page when the session is gone', async () => {
    const { deps } = app(false, true);
    await expect(createRunnerPort(deps).sessionLost?.()).resolves.toEqual({ lastUrl: DEAD });
  });

  it('looks for the session without resolve(), so the check marks no agent activity', async () => {
    const { deps, state } = app(false, true);
    await createRunnerPort(deps).sessionLost?.();
    await createRunnerPort(deps, 'driven').sessionLost?.();
    expect(state.resolves).toBe(0);
  });

  // The next flow's replay waits for its start page. A fixed wait here gave up on a slow dev server.
  it('opens the start URL again, and does not wait for a session', async () => {
    const { deps, state } = app(false, true);
    await createRunnerPort(deps).reopen?.();
    expect(state.reopens).toBe(1);
    // No clock read: the port did not start a wait of its own.
    expect(deps.now()).toBe(CLOCK_STEP_MS);
  });

  it('does not throw when the page did not load again', async () => {
    const { deps } = app(false, false);
    await expect(createRunnerPort(deps).reopen?.()).resolves.toBeUndefined();
  });
});

/*
 * Review of #2261: with no sessionId, resolve() also throws when two tabs are connected and none is
 * the clear winner. The HTTP verify path passes no sessionId, and the user's own tab can be
 * connected too. The port then said "no session after navigation", which was not true.
 */
describe('the live port with two connected tabs and no sessionId', () => {
  function twoTabs(): ToolDeps {
    const sessions = new SessionManager();
    for (const id of ['driven', 'users-tab']) {
      const tab = new Session(
        { ...fakeHello(), sessionId: id, url: START },
        { send: (): void => {} } as unknown as WebSocket,
        () => 0,
      );
      tab.touch();
      tab.applyHealth(false, true);
      sessions.add(tab);
    }
    let t = 0;
    return {
      sessions,
      realInput: { isAvailableFor: () => Promise.resolve(true), pageUrl: () => START },
      now: () => (t += CLOCK_STEP_MS),
    } as unknown as ToolDeps;
  }

  it('reports no loss, because sessions are connected', async () => {
    const deps = twoTabs();
    // The setup is the ambiguous case: an id-less resolve() refuses it.
    expect(() => deps.sessions.resolve()).toThrow('multiple sessions connected');
    await expect(createRunnerPort(deps).sessionLost?.()).resolves.toBeUndefined();
  });
});
