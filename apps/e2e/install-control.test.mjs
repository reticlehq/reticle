import { describe, expect, it } from 'vitest';
import {
  evaluateInstallControl,
  SESSION_CHECK,
  sessionMatchesPage,
  waitForVerifiableSession,
} from './install-control.mjs';

/**
 * The polling loop the install gate's load-bearing assertion rests on, driven on a fake clock.
 *
 * The incident is #558: a gate that treated "a session connected" as success passed an app that
 * registered `{ testids: [], signals: [], stores: [] }` and could never answer a state question.
 * The gate now waits for `hasCapabilities` after a session appears; these pin what that wait does
 * at its edges, which no self-test can reach — the negative control blocks the socket, so it only
 * ever exercises the "no session" half.
 */
describe('waiting for a verifiable session', () => {
  const CONNECT_MS = 45_000;
  const CAPABILITIES_MS = 10_000;
  const INTERVAL_MS = 500;
  const page = 'http://localhost:5173/?reticle-install-run=this-run';
  const isOurs = (s) => sessionMatchesPage(s, page);

  /** A bridge whose answer depends on the clock, and a clock that only moves when the loop sleeps. */
  function drive(sessionsAt) {
    let t = 0;
    const now = () => t;
    const sleep = async (ms) => {
      t += ms;
    };
    const run = () =>
      waitForVerifiableSession(() => sessionsAt(t), isOurs, {
        connectTimeoutMs: CONNECT_MS,
        capabilitiesWaitMs: CAPABILITIES_MS,
        intervalMs: INTERVAL_MS,
        now,
        sleep,
      });
    return { run, elapsed: () => t };
  }
  const session = (hasCapabilities, url = page) => ({ sessionId: 's', url, hasCapabilities });

  it('a session that connects late still gets the whole capabilities budget', async () => {
    // Connects 44s into a 45s window and re-announces 6s later — inside its 10s budget, outside
    // the connect window. A budget clipped to the connect deadline grades this install
    // "connected but unobservable" for having a slow dev server.
    const connectedAt = CONNECT_MS - 1_000;
    const { run } = drive((t) =>
      t < connectedAt ? [] : [session(t >= connectedAt + 6_000)],
    );
    expect(await run()).toMatchObject({ connected: true, verifiable: true });
  });

  it('a session that never advertises capabilities is connected but not verifiable', async () => {
    const { run, elapsed } = drive((t) => (t < 1_000 ? [] : [session(false)]));
    expect(await run()).toMatchObject({ connected: true, verifiable: false });
    // The wait is the capabilities budget after the session appeared: not cut short, not open-ended.
    expect(elapsed()).toBeGreaterThanOrEqual(1_000 + CAPABILITIES_MS);
    expect(elapsed()).toBeLessThanOrEqual(1_000 + CAPABILITIES_MS + INTERVAL_MS);
  });

  it('no session within the connect window spends nothing on the capabilities wait', async () => {
    const { run, elapsed } = drive(() => []);
    expect(await run()).toEqual({ sessions: [], connected: false, verifiable: false });
    expect(elapsed()).toBeGreaterThanOrEqual(CONNECT_MS);
    expect(elapsed()).toBeLessThanOrEqual(CONNECT_MS + INTERVAL_MS);
  });

  it('capabilities announced in the first HELLO return without sleeping', async () => {
    const { run, elapsed } = drive(() => [session(true)]);
    expect(await run()).toMatchObject({ connected: true, verifiable: true });
    expect(elapsed()).toBe(0);
  });

  it("another run's session never counts, however capable", async () => {
    const stray = session(true, 'http://localhost:5173/?reticle-install-run=previous-run');
    const { run } = drive(() => [stray]);
    expect(await run()).toMatchObject({ connected: false, verifiable: false });
  });

  it('a session that appeared and then vanished is connected, not absent', async () => {
    const { run } = drive((t) => (t < 2_000 ? [session(false)] : []));
    expect(await run()).toMatchObject({ connected: true, verifiable: false });
  });
});

describe('install page identity', () => {
  const page = 'http://localhost:5173/?reticle-install-run=this-run';

  it('accepts the page opened by this run', () => {
    expect(sessionMatchesPage({ url: page }, page)).toBe(true);
  });

  it.each([
    'http://localhost:5173/',
    'http://localhost:5173/?reticle-install-run=previous-run',
    'http://localhost:5174/?reticle-install-run=this-run',
    'http://localhost:5173/another-app?reticle-install-run=this-run',
    'not a URL',
    undefined,
  ])('refuses a different or unidentifiable session: %s', (url) => {
    expect(sessionMatchesPage({ url }, page)).toBe(false);
  });

  it('refuses an unmarked expected page', () => {
    expect(sessionMatchesPage({ url: page }, 'http://localhost:5173/')).toBe(false);
  });
});

// The old install self-test inverted any failure, including a failed publish or scaffold crash.
// A broken registry therefore printed SELF-TEST PASSED without exercising an install.
describe('install negative control', () => {
  const expected = ['vite-react'];
  const detected = { id: 'vite-react', fail: 1, failedChecks: [SESSION_CHECK] };

  it('accepts only the intended session failure for every requested scaffold', () => {
    expect(evaluateInstallControl([detected], expected).ok).toBe(true);
  });

  it.each([
    [],
    [{ id: 'setup', fail: 1 }],
    [{ id: 'vite-react', fail: 1 }],
    [{ id: 'vite-react', fail: 0, failedChecks: [] }],
    [{ ...detected, fail: 2, failedChecks: [SESSION_CHECK, 'the app boots'] }],
    [{ ...detected, failedChecks: ['transport unavailable'] }],
    [detected, detected],
  ])('rejects absent, unrelated, inconclusive, or duplicate evidence: %j', (...results) => {
    expect(evaluateInstallControl(results, expected).ok).toBe(false);
  });

  it('does not excuse a passing monorepo control', () => {
    expect(
      evaluateInstallControl(
        [{ id: 'monorepo-subdir', fail: 0, failedChecks: [] }],
        ['monorepo-subdir'],
      ).ok,
    ).toBe(false);
  });
});
