/**
 * Replay's half of the FlowFile contract: `startPath` says replay navigates there before step 1.
 * These pin the navigate-then-replay behaviour — that replay dispatches the navigation itself,
 * continues on the session the SDK reconnects as, and degrades to the wrong-page hint (never a
 * hang, never someone else's tab) when arrival cannot be confirmed.
 */

import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  FLOW_FILE_VERSION,
  PredicateKind,
  RETICLE_URL_PARAM,
  QueryBy,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { arriveAtStartPath } from './flow-replay-run.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';

const flow = (startPath?: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'sign-in',
  createdAt: 1,
  steps: [{ tool: 'reticle_act', anchor: { kind: AnchorKind.TESTID, value: 'submit' } }],
  ...(startPath === undefined ? {} : { startPath }),
});

/** The declared opt-out: a flow that continues another flow's state is never reset under it. */
const continues = (startPath: string): FlowFile => ({
  ...flow(startPath),
  requires: [{ kind: PredicateKind.SIGNAL, name: 'auth:ready' }],
});

interface NavCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * A connected tab that accepts (or refuses) a NAVIGATE and records what it was sent.
 *
 * `stepOnPage` answers the QUERY `arriveAtStartPath` now runs first — "can step 1 start from here?".
 * It defaults FALSE, which is the situation these cases are about: the tab is on the wrong route AND
 * the flow's first anchor is not on it, so the navigation is the thing that helps. The true case has
 * its own test below, because it is the one that used to navigate and must no longer.
 */
function tab(
  url: string | undefined,
  options: { accepted?: boolean; stepOnPage?: boolean; id?: string } = {},
): {
  calls: NavCall[];
  session: {
    id: string;
    url?: string;
    eventsSince: () => never[];
    command: (name: string, args?: Record<string, unknown>) => Promise<CommandResult>;
  };
} {
  const calls: NavCall[] = [];
  return {
    calls,
    session: {
      id: options.id ?? 'old',
      ...(url === undefined ? {} : { url }),
      eventsSince: () => [],
      command: (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        if (name === ReticleCommand.QUERY) {
          return Promise.resolve({
            kind: 'command_result',
            id: 'q',
            ok: true,
            result: { elements: true === options.stepOnPage ? [{ ref: 'e1' }] : [] },
          } as CommandResult);
        }
        return Promise.resolve({
          kind: 'command_result',
          id: 'n',
          ok: true,
          result: { ok: options.accepted ?? true },
        } as CommandResult);
      },
    },
  };
}

/**
 * A manager whose `resolve('old')` answers from a script, one entry per look — mirroring the
 * tombstone rebind: first the still-registered old tab, later the successor on the new page.
 */
function manager(resolutionsOverTime: (Partial<Session> | undefined)[]): SessionManager {
  let look = 0;
  return {
    resolve: () => {
      const found = resolutionsOverTime[Math.min(look, resolutionsOverTime.length - 1)];
      look++;
      if (found === undefined) throw new Error('no connected session');
      return found as Session;
    },
  } as unknown as SessionManager;
}

/** A clock that advances only when slept on — deterministic and instant, as navigate-arrival's. */
function instantClock(step: number): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: () => {
      t += step;
      return Promise.resolve();
    },
  };
}

const successor = (url: string): Partial<Session> => ({ id: 'fresh', url, eventsSince: () => [] });

describe('arriveAtStartPath — replay navigates to the flow start page before step 1', () => {
  it('dispatches the navigation and returns the session the SDK reconnects as', async () => {
    const { calls, session } = tab('http://localhost:3000/reset-password');
    const fresh = successor('http://localhost:3000/login');
    const sessions = manager([session, fresh]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived.session).toBe(fresh);
    // The QUERY that establishes step 1 cannot start here comes first; the navigation follows it.
    expect(calls).toEqual([
      { name: ReticleCommand.QUERY, args: { by: QueryBy.TESTID, value: 'submit' } },
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/login' } },
    ]);
  });

  /*
   * The state contract, and the reason it is worth a page load.
   *
   * Replay used to do NOTHING when the tab already sat on the start page, so a flow replayed twice
   * ran the second time against whatever the first had left behind — a filled form, an open dialog,
   * the row it had just added. The recording's assertions are about a world that no longer exists,
   * and the resulting red is about the previous run, not about the app.
   *
   * The benchmark has always controlled for this: `replay-determinism.mjs` refreshes before EVERY
   * run, which means the determinism it measures was never the determinism a user got. This makes
   * the product do what the benchmark does.
   */
  it('reloads when the tab already sits on the start page, so step 1 starts from a known state', async () => {
    const { calls, session } = tab('http://localhost:3000/login');
    const fresh = successor('http://localhost:3000/login');
    const arrived = await arriveAtStartPath(
      manager([session, fresh]),
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived.session).toBe(fresh);
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/login' } },
    ]);
  });

  /*
   * A reset RELOADS the page the tab is on; it does not rewrite the URL.
   *
   * `samePath` ignores a query the flow did not record, on the stated ground that `?next=%2F` on a
   * login page is not the flow being elsewhere. The reset then navigated to `startPath` itself and
   * stripped that query anyway, so every replay silently changed the page it was about to test.
   * Found by the benchmark: its regressions ride on a query param, and after the reset landed every
   * replay-detection scenario reported 0 caught against an app that was still broken.
   */
  it('keeps a query the flow did not record when it reloads in place', async () => {
    const { calls, session } = tab('http://localhost:3000/login?next=%2Fdash');
    const fresh = successor('http://localhost:3000/login?next=%2Fdash');
    await arriveAtStartPath(
      manager([session, fresh]),
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/login?next=%2Fdash' } },
    ]);
  });

  /*
   * The opt-out, and it is DECLARED rather than inferred.
   *
   * `requires` says this flow starts from state some other flow established. A page load is exactly
   * what discards that, so the flow that says so is the flow that is never reset — on the start page
   * or anywhere else. Until now nothing read `requires` before the steps ran; this is its caller.
   */
  it('does not reset a flow that declares `requires`', async () => {
    const { calls, session } = tab('http://localhost:3000/login');
    const arrived = await arriveAtStartPath(manager([]), session, continues('/login'));
    expect(arrived.session).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('does not navigate a flow that declares `requires` even from the wrong page', async () => {
    const { calls, session } = tab('http://localhost:3000/elsewhere');
    const arrived = await arriveAtStartPath(manager([]), session, continues('/login'));
    expect(arrived.session).toBeUndefined();
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([]);
  });

  /*
   * A leased tab keeps its id across the reload — that is what the identity params are for.
   *
   * Found by driving, not by a test: the first version waited for a NEW session id, which a lease
   * never produces, so arrival timed out and replay carried on through the dead pre-reload handle.
   * Every query then hit the 8s command window and the flow died at step 1 on a healthy tab.
   */
  it('accepts a successor that reconnects under the same id (a leased tab)', async () => {
    const { session } = tab('http://localhost:4312/compose', { id: 'lease-1' });
    const fresh = tab('http://localhost:4312/compose', { id: 'lease-1' }).session;
    const arrived = await arriveAtStartPath(
      manager([session, fresh]),
      session,
      flow('/compose'),
      5_000,
      instantClock(100),
    );
    expect(arrived.session).toBe(fresh);
  });

  /*
   * What the reload costs, said out loud instead of blamed on the flow file.
   *
   * An app that holds its session in memory comes back from a page load signed out, and step 1 then
   * reports its anchor missing and names a component that is completely fine — the same wrong
   * sentence the wrong-page navigation used to produce. So the reset MEASURES the anchor either
   * side of itself: reachable before and gone after is the reset's doing, and replay says so.
   */
  it('says so when the reload itself cost step 1 its anchor', async () => {
    const { session } = tab('http://localhost:3000/login', { stepOnPage: true });
    const fresh = tab('http://localhost:3000/login', { stepOnPage: false, id: 'fresh' }).session;
    const arrived = await arriveAtStartPath(
      manager([session, fresh]),
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived.session).toBe(fresh);
    expect(arrived.resetCost).toContain('requires');
  });

  it('is silent when the anchor survives the reload', async () => {
    const { session } = tab('http://localhost:3000/login', { stepOnPage: true });
    const fresh = tab('http://localhost:3000/login', { stepOnPage: true, id: 'fresh' }).session;
    const arrived = await arriveAtStartPath(
      manager([session, fresh]),
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived.resetCost).toBeUndefined();
  });

  it('does nothing for a flow with no startPath (back-compat)', async () => {
    const { calls, session } = tab('http://localhost:3000/anywhere');
    const arrived = await arriveAtStartPath(manager([]), session, flow());
    expect(arrived.session).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('never navigates blind: an unobservable current route stays put', async () => {
    const { calls, session } = tab(undefined);
    const arrived = await arriveAtStartPath(manager([]), session, flow('/login'));
    expect(arrived.session).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('falls back (undefined) when the browser refuses the navigation', async () => {
    const { calls, session } = tab('http://localhost:3000/reset-password', { accepted: false });
    const arrived = await arriveAtStartPath(manager([]), session, flow('/login'));
    expect(arrived.session).toBeUndefined();
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toHaveLength(1);
  });

  it('gives up after the window rather than hanging when the SDK never reconnects', async () => {
    const { session } = tab('http://localhost:3000/reset-password');
    // resolve keeps answering the old tab, still on the old page — arrival never happens.
    const sessions = manager([session]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/login'),
      500,
      instantClock(100),
    );
    expect(arrived.session).toBeUndefined();
  });

  it('keeps waiting through the teardown gap where the old id resolves to nothing yet', async () => {
    const { session } = tab('http://localhost:3000/reset-password');
    const fresh = successor('http://localhost:3000/login');
    const sessions = manager([session, undefined, undefined, fresh]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived.session).toBe(fresh);
  });

  // The regression this guard exists for, found by the benchmark rather than by a test.
  //
  // Two saved flows with IDENTICAL steps, replayed in one suite: the first passed, the second failed
  // on step 1 with `testid "nav-diagnostics" not found` and named the sidebar component holding it —
  // a correct sentence about a file that was completely fine. The first replay had left the tab on
  // another route, so the second navigated "back" to its startPath; the page load dropped the login,
  // and the anchor really was gone, from the login screen. The anchor had been on the page the whole
  // time, in a sidebar that renders on every route. Navigating could only hurt, and did.
  it('does not navigate when step 1 can already start from this page', async () => {
    const { calls, session } = tab('http://localhost:3000/diagnostics', { stepOnPage: true });
    const arrived = await arriveAtStartPath(manager([]), session, flow('/'));
    expect(arrived.session).toBeUndefined();
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([]);
  });

  // The other half of the same rule: a query that cannot answer is not evidence the page is fine.
  // "Cannot tell" keeps the navigation, which is what this did before the guard existed.
  it('still navigates when the page cannot be asked', async () => {
    const { calls, session } = tab('http://localhost:3000/elsewhere');
    const fresh = successor('http://localhost:3000/login');
    const arrived = await arriveAtStartPath(
      manager([session, fresh]),
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(arrived.session).toBe(fresh);
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toHaveLength(1);
  });

  it('carries a leased tab’s identity params so the navigation cannot strand the lease', async () => {
    const leased = `http://localhost:3000/?${RETICLE_URL_PARAM.SESSION}=lease-1`;
    const { calls, session } = tab(leased);
    const fresh = successor(`http://localhost:3000/checkout?${RETICLE_URL_PARAM.SESSION}=lease-1`);
    const sessions = manager([session, fresh]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/checkout'),
      5_000,
      instantClock(100),
    );
    expect(arrived.session).toBe(fresh);
    const sent = String(calls.find((c) => c.name === ReticleCommand.NAVIGATE)?.args['url']);
    expect(sent).toContain('/checkout');
    expect(sent).toContain(`${RETICLE_URL_PARAM.SESSION}=lease-1`);
  });
});
