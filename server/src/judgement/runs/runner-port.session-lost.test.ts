/**
 * #2060: `reticle verify` must see that a flow left the app on a page with no session, say the URL
 * of that page, and open the app again for the next flow. This is the live port's half: it reads the
 * session and the driven page. ReticleRunner decides what the run reports.
 */
import { describe, expect, it } from 'vitest';
import { createRunnerPort } from '@/judgement/runs/runner-port.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

const START = 'http://localhost:3000/';
const DEAD = 'http://localhost:3000/stats?id=missing';
/** Each read of the clock moves it one second, so a wait for a session ends after a few polls. */
const CLOCK_STEP_MS = 1000;

function app(connected: boolean, reopenLoads: boolean) {
  const state = { connected, reopens: 0 };
  let t = 0;
  const deps = {
    sessions: {
      resolve: () => {
        if (!state.connected) {
          throw new Error('no browser session connected');
        }
        return { url: START };
      },
    },
    realInput: {
      isAvailableFor: () => Promise.resolve(true),
      pageUrl: () => (state.connected ? START : DEAD),
      reopen: () => {
        state.reopens += 1;
        state.connected = reopenLoads;
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

  it('opens the start URL again, and is true when a session comes back', async () => {
    const { deps, state } = app(false, true);
    await expect(createRunnerPort(deps).reopen?.()).resolves.toBe(true);
    expect(state.reopens).toBe(1);
  });

  it('is false when the page did not load again', async () => {
    const { deps } = app(false, false);
    await expect(createRunnerPort(deps).reopen?.()).resolves.toBe(false);
  });
});
