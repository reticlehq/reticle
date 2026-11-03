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
  ReplayStatus,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import {
  arriveAtStartPath,
  noteReplayEnded,
  routeClaimsWhereTheTabIs,
  withStartPageWait,
} from './flow-start-path.js';
import { onRoute } from './flow-journey.js';
import { runSequentially } from './suite/sequential-run.js';
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
/** What a QUERY on this fake page finds: `matches` elements, or one when `stepOnPage`. */
function elementsOnPage(options: { stepOnPage?: boolean; matches?: number }): { ref: string }[] {
  if (options.matches !== undefined) {
    return Array.from({ length: options.matches }, (_, i) => ({ ref: `e${String(i)}` }));
  }
  return true === options.stepOnPage ? [{ ref: 'e1' }] : [];
}

function tab(
  url: string | undefined,
  options: { accepted?: boolean; stepOnPage?: boolean; matches?: number; id?: string } = {},
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
            result: { elements: elementsOnPage(options) },
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
      if (found === undefined) {
        throw new Error('no connected session');
      }
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
   * A query that the LAST replay left is not a query that the caller chose.
   *
   * A suite replays its flows one after the other in the same tab. One flow checked "Show only unused
   * tags", so the tab was on `/tags?unused=true` when the next flow, recorded on `/tags`, started.
   * The reset reloaded that URL with the filter, and the next flow searched a filtered list: a false
   * fail on a correct app. The page that the replay left is reset to `startPath` itself.
   */
  it('drops a query that the previous replay left on the same tab', async () => {
    const left = 'http://localhost:3000/tags?search=o&unused=true';
    const { calls, session } = tab(left);
    noteReplayEnded(session);
    await arriveAtStartPath(
      manager([session, successor('http://localhost:3000/tags')]),
      session,
      flow('/tags'),
      5_000,
      instantClock(100),
    );
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/tags' } },
    ]);
  });

  it('keeps the query when a new page loaded after the previous replay', async () => {
    const url = 'http://localhost:3000/login?next=%2Fdash';
    noteReplayEnded(tab(url, { id: 'earlier' }).session);
    const { calls, session } = tab(url, { id: 'loaded-since' });
    await arriveAtStartPath(
      manager([session, successor(url)]),
      session,
      flow('/login'),
      5_000,
      instantClock(100),
    );
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url } },
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
    // No tool writes `requires`, so the hint carries the exact line to add: the flow's own first
    // anchor as its precondition, which is what "starts from state a reload discards" means here.
    expect(arrived.resetCost).toContain(
      '"requires":[{"kind":"element","query":{"testid":"submit"}}]',
    );
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
    // Refused is not lost: the tab never left, so the connected session still answers.
    expect(arrived.lost).toBeUndefined();
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
    // The navigate WAS sent: the handle replay holds is gone, and continuing on it would time every
    // step out. Said, so replay can stop as unverifiable instead (#1129).
    expect(arrived.lost).toContain('no page was connected after 500ms');
  });

  it('uses a live successor on an auth redirect instead of calling the page lost', async () => {
    const { session } = tab('http://localhost:3000/home');
    const login = successor('http://localhost:3000/auth');
    const arrived = await arriveAtStartPath(
      manager([session, login]),
      session,
      flow('/checkout'),
      300,
      instantClock(100),
    );
    expect(arrived.session).toBe(login);
    expect(arrived.lost).toBeUndefined();
    expect(arrived.redirected).toContain('reconnected on /auth');
  });

  it('keeps waiting when a redirect later reaches the requested page', async () => {
    const { session } = tab('http://localhost:3000/home');
    const login = successor('http://localhost:3000/auth');
    const checkout = successor('http://localhost:3000/checkout');
    const arrived = await arriveAtStartPath(
      manager([session, login, checkout]),
      session,
      flow('/checkout'),
      500,
      instantClock(100),
    );
    expect(arrived.session).toBe(checkout);
    expect(arrived.redirected).toBeUndefined();
  });

  it('does not reuse a redirected handle that disconnected before the deadline', async () => {
    const { session } = tab('http://localhost:3000/home');
    const login = successor('http://localhost:3000/auth');
    const arrived = await arriveAtStartPath(
      manager([session, login, undefined]),
      session,
      flow('/checkout'),
      300,
      instantClock(100),
    );
    expect(arrived.session).toBeUndefined();
    expect(arrived.lost).toContain('no page was connected');
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

  /*
   * A role and a name on another page is a namesake, not the control the flow recorded.
   *
   * A flow recorded on `/tags` starts with a click on button "Search". The tab was on `/bookmarks`,
   * which has its own button "Search". Replay did not navigate, clicked the bookmark search, and the
   * flow failed on a correct app. A testid is the app's own name for a control, so the sidebar case
   * above keeps its shortcut; a role and a name do not.
   */
  it('navigates when step 1 matches here only by role and name', async () => {
    const { calls, session } = tab('http://localhost:3000/bookmarks', { stepOnPage: true });
    const byName: FlowFile = {
      ...flow('/tags'),
      steps: [
        { tool: 'reticle_act', anchor: { kind: AnchorKind.ROLE, role: 'button', name: 'Search' } },
      ],
    };
    await arriveAtStartPath(
      manager([session, successor('http://localhost:3000/tags')]),
      session,
      byName,
      5_000,
      instantClock(100),
    );
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/tags' } },
    ]);
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

/**
 * Replay waited a fixed 5 s for the start page to reconnect. A dev server that compiles the route
 * on the first visit takes longer, and the flow ended as unverifiable with nothing run. The wait
 * now spends the first step's budget when that is longer.
 */
describe('arriveAtStartPath waits for as long as the first step may wait', () => {
  it('continues on a page that reconnects at 8 s when the step budget is 15 s', async () => {
    const clock = instantClock(100);
    const { session } = tab(undefined, { id: 'gone' });
    const fresh = successor('http://localhost:3000/login');
    const sessions = {
      resolve: () => {
        if (clock.now() < 8_000) {
          throw new Error('no connected session');
        }
        return fresh as Session;
      },
    } as unknown as SessionManager;
    const slow: FlowFile = {
      ...flow('/login'),
      steps: [
        {
          tool: 'reticle_act',
          anchor: { kind: AnchorKind.TESTID, value: 'submit' },
          timeoutMs: 15_000,
        },
      ],
    };
    const arrived = await arriveAtStartPath(
      sessions,
      { ...session, url: 'http://localhost:3000/reset-password' },
      slow,
      undefined,
      clock,
    );
    expect(arrived.lost).toBeUndefined();
    expect(arrived.session).toBe(fresh);
  });
});

/**
 * #1705, the other half: a cold dev server (a first Next.js compile) can hold the start page past
 * the step budget. While the leased tab says the page is still loading, replay keeps waiting, up to
 * a cap. A page that has loaded keeps the budget. The result says when the wait went past it.
 */
describe('arriveAtStartPath keeps waiting past the budget while the page is still loading', () => {
  it('continues on a page that loads after the budget and before the cap, and says so', async () => {
    const { session } = tab('http://localhost:3000/reset-password');
    // The SDK reconnects on the eleventh look, at t=1000ms, twice the 500ms budget.
    const sessions = manager([
      ...Array<Partial<Session>>(10).fill(session),
      successor('http://localhost:3000/login'),
    ]);
    const arrived = await arriveAtStartPath(
      sessions,
      session,
      flow('/login'),
      500,
      instantClock(100),
      () => Promise.resolve(true),
    );
    expect(arrived.lost).toBeUndefined();
    expect(arrived.session?.id).toBe('fresh');
    expect(arrived.wait).toEqual({ waitedMs: 1000, budgetMs: 500, stillLoading: true });
  });

  it('fails at the 30 s cap when the page never finishes loading, and says it was still loading', async () => {
    const { session } = tab('http://localhost:3000/reset-password');
    const arrived = await arriveAtStartPath(
      manager([session]),
      session,
      flow('/login'),
      undefined,
      instantClock(100),
      () => Promise.resolve(true),
    );
    expect(arrived.session).toBeUndefined();
    expect(arrived.lost).toContain('no page was connected after 30000ms');
    expect(arrived.lost).toContain('still loading');
    expect(arrived.wait).toEqual({ waitedMs: 30_000, budgetMs: 5_000, stillLoading: true });
  });

  it('fails at the budget once the page has finished loading', async () => {
    const { session } = tab('http://localhost:3000/reset-password');
    let asked = 0;
    const arrived = await arriveAtStartPath(
      manager([session]),
      session,
      flow('/login'),
      500,
      instantClock(100),
      () => {
        asked++;
        return Promise.resolve(false);
      },
    );
    expect(asked).toBeGreaterThan(0);
    expect(arrived.lost).toContain('no page was connected after 500ms');
    expect(arrived.lost).not.toContain('still loading');
    expect(arrived.wait).toBeUndefined();
  });

  it('fails at the budget on a page that connected on another route, loading or not', async () => {
    const { session } = tab('http://localhost:3000/home');
    const login = successor('http://localhost:3000/auth');
    const arrived = await arriveAtStartPath(
      manager([session, login]),
      session,
      flow('/checkout'),
      300,
      instantClock(100),
      () => Promise.resolve(true),
    );
    expect(arrived.session).toBe(login);
    expect(arrived.redirected).toContain('reconnected on /auth');
    expect(arrived.wait).toBeUndefined();
  });

  it('counts a probe that fails as loaded, so it cannot stretch the wait', async () => {
    const { session } = tab('http://localhost:3000/reset-password');
    const arrived = await arriveAtStartPath(
      manager([session]),
      session,
      flow('/login'),
      500,
      instantClock(100),
      () => Promise.reject(new Error('page closed')),
    );
    expect(arrived.lost).toContain('no page was connected after 500ms');
    expect(arrived.wait).toBeUndefined();
  });
});

describe('withStartPageWait', () => {
  const result = { name: 'sign-in', status: ReplayStatus.OK, steps: [] };

  it('puts an extended wait on the replay result', () => {
    const wait = { waitedMs: 12_000, budgetMs: 5_000, stillLoading: false };
    expect(withStartPageWait(result, { wait })).toEqual({ ...result, startPageWait: wait });
  });

  it('leaves the result alone when the wait stayed inside the budget', () => {
    expect(withStartPageWait(result, {})).toBe(result);
  });

  /*
   * "Can step 1 start here" means the anchor finds THE control the recording meant, not just one of
   * that name. A flow recorded on a tags page clicks "Edit" 1 of 10; a bookmarks page has 30 links
   * named "Edit". Replay stayed on the bookmarks page because the name matched, then refused the
   * step as ambiguous: a correct app replayed `unknown`.
   */
  const editOnTags = (): FlowFile => ({
    ...flow('/tags'),
    steps: [
      {
        tool: 'reticle_act',
        anchor: { kind: AnchorKind.ROLE, role: 'link', name: 'Edit', nth: 0, of: 10 },
      },
    ],
  });

  it('navigates when this page has the name but not the recorded number of them', async () => {
    const { calls, session } = tab('http://localhost:3000/bookmarks', { matches: 30 });
    const fresh = successor('http://localhost:3000/tags');
    const arrived = await arriveAtStartPath(
      manager([session, fresh]),
      session,
      editOnTags(),
      5_000,
      instantClock(100),
    );
    expect(arrived.session).toBe(fresh);
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toHaveLength(1);
  });

  // The same count on another page is still another page's links: a role and a name do not say
  // which control they are. See 'navigates when step 1 matches here only by role and name'.
  it('navigates even when another page has exactly the recorded number of them', async () => {
    const { calls, session } = tab('http://localhost:3000/other', { matches: 10 });
    const fresh = successor('http://localhost:3000/tags');
    const arrived = await arriveAtStartPath(
      manager([session, fresh]),
      session,
      editOnTags(),
      5_000,
      instantClock(100),
    );
    expect(arrived.session).toBe(fresh);
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toHaveLength(1);
  });
});

/**
 * #2034: a suite replays its flows one after the other in one tab. A flow that declares the route
 * it needs (`requires` route) ran on whatever page the previous flow left open, so its anchors
 * failed or matched ambiguously on an unrelated page, and the verdict depended on the suite order.
 */
describe('arriveAtStartPath — a flow that declares its route runs on that route', () => {
  /** A one-tab browser: a NAVIGATE loads the page it names, under a new session id. */
  function browser(url: string): {
    sessions: SessionManager;
    tab: () => ReturnType<typeof tab>['session'];
    url: () => string;
    navigations: string[];
  } {
    let page = { id: 'page-0', url };
    const navigations: string[] = [];
    const current = (): ReturnType<typeof tab>['session'] => ({
      id: page.id,
      url: page.url,
      eventsSince: () => [],
      command: (name: string, args: Record<string, unknown> = {}) => {
        if (name === ReticleCommand.NAVIGATE) {
          navigations.push(String(args['url']));
          page = { id: `page-${String(navigations.length)}`, url: String(args['url']) };
          return Promise.resolve({
            kind: 'command_result',
            id: 'n',
            ok: true,
            result: { ok: true },
          } as CommandResult);
        }
        return Promise.resolve({
          kind: 'command_result',
          id: 'q',
          ok: true,
          result: { elements: [] },
        } as CommandResult);
      },
    });
    const sessions = { resolve: () => current() } as unknown as SessionManager;
    return { sessions, tab: current, url: () => page.url, navigations };
  }

  const needs = (route: string, startPath?: string): FlowFile => ({
    ...flow(startPath),
    name: 'orders',
    requires: [{ kind: PredicateKind.ROUTE, pathname: route }],
  });

  it('runs flow B on /orders after flow A ended on /settings', async () => {
    const app = browser('http://localhost:3000/');
    const ranOn: string[] = [];
    const suite = await runSequentially(['settings', 'orders'], {
      now: () => 0,
      budgetMs: 60_000,
      sessionAlive: () => true,
      run: async (name) => {
        const next = 'settings' === name ? flow('/settings') : needs('/orders');
        await arriveAtStartPath(app.sessions, app.tab(), next, 5_000, instantClock(100));
        ranOn.push(new URL(app.url()).pathname);
        noteReplayEnded(app.tab());
        return name;
      },
    });
    expect(suite.results).toEqual(['settings', 'orders']);
    expect(ranOn).toEqual(['/settings', '/orders']);
  });

  it('navigates to a declared route that differs from the startPath', async () => {
    const app = browser('http://localhost:3000/settings');
    const arrived = await arriveAtStartPath(
      app.sessions,
      app.tab(),
      needs('/orders', '/settings'),
      5_000,
      instantClock(100),
    );
    expect(app.navigations).toEqual(['http://localhost:3000/orders']);
    expect(arrived.unreached).toBeUndefined();
  });

  it('goes to the route even when a testid of step 1 is on the wrong page', async () => {
    const { calls, session } = tab('http://localhost:3000/settings', { stepOnPage: true });
    const arrived = await arriveAtStartPath(
      manager([session, successor('http://localhost:3000/orders')]),
      session,
      needs('/orders'),
      5_000,
      instantClock(100),
    );
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/orders' } },
    ]);
    expect(arrived.session?.id).toBe('fresh');
  });

  it('keeps the persistent-anchor shortcut for a route claim that is the startPath', async () => {
    const { calls, session } = tab('http://localhost:3000/diagnostics', { stepOnPage: true });
    const arrived = await arriveAtStartPath(manager([]), session, needs('/', '/'));
    expect(arrived).toEqual({});
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([]);
  });

  it('says the route was not reached when the browser refuses to open it', async () => {
    const { session } = tab('http://localhost:3000/settings', { accepted: false });
    const arrived = await arriveAtStartPath(manager([]), session, needs('/orders'));
    expect(arrived.unreached).toContain('declares that it starts on /orders');
    expect(arrived.unreached).toContain('the tab is on /settings');
    expect(arrived.unreached).toContain('refused to open /orders');
  });

  it('says the route was not reached when the app sends the tab elsewhere', async () => {
    const { session } = tab('http://localhost:3000/settings');
    const arrived = await arriveAtStartPath(
      manager([session, successor('http://localhost:3000/login')]),
      session,
      needs('/orders'),
      300,
      instantClock(100),
    );
    expect(arrived.redirected).toBeUndefined();
    expect(arrived.unreached).toContain('the tab is on /login');
    // The live successor is still handed back: the old handle is gone either way.
    expect(arrived.session?.id).toBe('fresh');
  });

  it('says the route was not reached when the page is not observable', async () => {
    const { calls, session } = tab(undefined);
    const arrived = await arriveAtStartPath(manager([]), session, needs('/orders'));
    expect(arrived.unreached).toContain('cannot see which page');
    expect(calls).toEqual([]);
  });

  it('does not move a flow that also declares other state, and says the route was not reached', async () => {
    const { calls, session } = tab('http://localhost:3000/settings');
    const both: FlowFile = {
      ...needs('/orders'),
      requires: [
        { kind: PredicateKind.ROUTE, pathname: '/orders' },
        { kind: PredicateKind.SIGNAL, name: 'auth:ready' },
      ],
    };
    const arrived = await arriveAtStartPath(manager([]), session, both);
    expect(calls).toEqual([]);
    expect(arrived.unreached).toContain('does not move the tab');
  });

  it('leaves a flow that also declares other state alone when it is already on the route', async () => {
    const { calls, session } = tab('http://localhost:3000/orders');
    const both: FlowFile = {
      ...needs('/orders'),
      requires: [
        { kind: PredicateKind.ROUTE, pathname: '/orders' },
        { kind: PredicateKind.SIGNAL, name: 'auth:ready' },
      ],
    };
    expect(await arriveAtStartPath(manager([]), session, both)).toEqual({});
    expect(calls).toEqual([]);
  });
  // A saved drive writes the startPath claim first. A route added after it is still the route.
  it('goes to the declared route when the startPath claim comes first', async () => {
    const app = browser('http://localhost:3000/settings');
    const arrived = await arriveAtStartPath(
      app.sessions,
      app.tab(),
      {
        ...flow('/settings'),
        requires: [
          { kind: PredicateKind.ROUTE, pathname: '/settings' },
          { kind: PredicateKind.ROUTE, pathname: '/orders' },
        ],
      },
      5_000,
      instantClock(100),
    );
    expect(app.navigations).toEqual(['http://localhost:3000/orders']);
    expect(arrived.unreached).toBeUndefined();
  });

  it('says the route was not reached when two declared routes cannot both hold', async () => {
    const app = browser('http://localhost:3000/settings');
    const arrived = await arriveAtStartPath(
      app.sessions,
      app.tab(),
      {
        ...flow(),
        requires: [
          { kind: PredicateKind.ROUTE, pathname: '/orders' },
          { kind: PredicateKind.ROUTE, pathname: '/invoices' },
        ],
      },
      5_000,
      instantClock(100),
    );
    expect(app.navigations).toEqual(['http://localhost:3000/orders']);
    expect(arrived.unreached).toContain('it is not on /invoices');
  });

  // `contains` is part of the claim: it is checked on the page replay arrives at.
  it('checks the `contains` of a route claim once the tab is on the route', async () => {
    const withContains = (): FlowFile => ({
      ...flow(),
      requires: [{ kind: PredicateKind.ROUTE, pathname: '/orders', contains: 'tab=open' }],
    });
    const missing = browser('http://localhost:3000/settings');
    const unmet = await arriveAtStartPath(
      missing.sessions,
      missing.tab(),
      withContains(),
      5_000,
      instantClock(100),
    );
    expect(unmet.unreached).toContain('does not contain "tab=open"');
    const present = browser('http://localhost:3000/orders?tab=open');
    const met = await arriveAtStartPath(
      present.sessions,
      present.tab(),
      withContains(),
      5_000,
      instantClock(100),
    );
    expect(present.navigations).toEqual(['http://localhost:3000/orders?tab=open']);
    expect(met.unreached).toBeUndefined();
  });

  it('checks the declared route where the tab is when replay continues mid-flow', () => {
    expect(
      routeClaimsWhereTheTabIs(needs('/orders'), tab('http://localhost:3000/settings').session)
        .unreached,
    ).toContain('it is not on /orders');
    expect(
      routeClaimsWhereTheTabIs(needs('/orders'), tab('http://localhost:3000/orders').session),
    ).toEqual({});
    expect(
      routeClaimsWhereTheTabIs(flow('/settings'), tab('http://localhost:3000/elsewhere').session),
    ).toEqual({});
  });
});

/**
 * #2034, the second report: the route names an entity (`/cases/:id/notes`), and the recorded
 * address is a case that was deleted since. Replay sent the tab to that case and answered
 * `unknown` for a generic flow that should have stayed on the case the tab was on.
 */
describe('arriveAtStartPath — a route with an entity id', () => {
  const recordedOnDeletedCase = (): FlowFile => ({
    ...flow('/cases/c-deleted/notes'),
    name: 'case-notes',
    requires: [{ kind: PredicateKind.ROUTE, pathname: '/cases/:id/notes' }],
  });

  it('keeps the id of the page the tab is on, not the recorded id', async () => {
    const { calls, session } = tab('http://localhost:3000/cases/c-42/notes');
    const arrived = await arriveAtStartPath(
      manager([session, successor('http://localhost:3000/cases/c-42/notes')]),
      session,
      recordedOnDeletedCase(),
      5_000,
      instantClock(100),
    );
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/cases/c-42/notes' } },
    ]);
    expect(arrived.unreached).toBeUndefined();
    expect(arrived.session?.id).toBe('fresh');
  });

  it('keeps the id under a hash router', async () => {
    const { calls, session } = tab('http://localhost:3000/#/cases/c-42/notes');
    await arriveAtStartPath(
      manager([session, successor('http://localhost:3000/#/cases/c-42/notes')]),
      session,
      {
        ...recordedOnDeletedCase(),
        startPath: '/#/cases/c-deleted/notes',
        requires: [{ kind: PredicateKind.ROUTE, pathname: '/#/cases/:id/notes' }],
      },
      5_000,
      instantClock(100),
    );
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/#/cases/c-42/notes' } },
    ]);
  });

  it('navigates to the recorded address from a page off the route', async () => {
    const { calls, session } = tab('http://localhost:3000/settings');
    await arriveAtStartPath(
      manager([session, successor('http://localhost:3000/cases/c-deleted/notes')]),
      session,
      recordedOnDeletedCase(),
      5_000,
      instantClock(100),
    );
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      {
        name: ReticleCommand.NAVIGATE,
        args: { url: 'http://localhost:3000/cases/c-deleted/notes' },
      },
    ]);
  });

  it('says the route was not reached when the recorded case is gone and the app redirects', async () => {
    const { session } = tab('http://localhost:3000/settings');
    const arrived = await arriveAtStartPath(
      manager([session, successor('http://localhost:3000/cases')]),
      session,
      recordedOnDeletedCase(),
      300,
      instantClock(100),
    );
    expect(arrived.unreached).toContain('declares that it starts on /cases/:id/notes');
    expect(arrived.unreached).toContain('the tab is on /cases');
  });

  it('does not navigate to a pattern it has no address for', async () => {
    const { calls, session } = tab('http://localhost:3000/settings');
    const arrived = await arriveAtStartPath(manager([]), session, {
      ...flow(),
      requires: [{ kind: PredicateKind.ROUTE, pathname: '/cases/:id/notes' }],
    });
    expect(calls).toEqual([]);
    expect(arrived.unreached).toContain('no address on that route');
  });

  // The field report: a generic section navigation inside a case stays on that case. From another
  // section of case c-42, the deleted recorded case c-deleted is never opened.
  it('takes the id from another section of the same case, not the recorded id', async () => {
    const { calls, session } = tab('http://localhost:3000/cases/c-42/files');
    const arrived = await arriveAtStartPath(
      manager([session, successor('http://localhost:3000/cases/c-42/notes')]),
      session,
      recordedOnDeletedCase(),
      5_000,
      instantClock(100),
    );
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/cases/c-42/notes' } },
    ]);
    expect(arrived.unreached).toBeUndefined();
  });

  it('takes every id the tab can give, and only while the segments before it agree', async () => {
    const nested = (): FlowFile => ({
      ...flow('/orgs/o-deleted/cases/c-deleted/notes'),
      requires: [{ kind: PredicateKind.ROUTE, pathname: '/orgs/:org/cases/:id/notes' }],
    });
    const inCase = tab('http://localhost:3000/orgs/o-1/cases/c-42/files');
    await arriveAtStartPath(
      manager([inCase.session, successor('http://localhost:3000/orgs/o-1/cases/c-42/notes')]),
      inCase.session,
      nested(),
      5_000,
      instantClock(100),
    );
    expect(inCase.calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      {
        name: ReticleCommand.NAVIGATE,
        args: { url: 'http://localhost:3000/orgs/o-1/cases/c-42/notes' },
      },
    ]);
    // `/orgs/o-1/settings` gives an org but no case, so replay falls back to the recorded address.
    const inOrg = tab('http://localhost:3000/orgs/o-1/settings');
    await arriveAtStartPath(
      manager([
        inOrg.session,
        successor('http://localhost:3000/orgs/o-deleted/cases/c-deleted/notes'),
      ]),
      inOrg.session,
      nested(),
      5_000,
      instantClock(100),
    );
    expect(inOrg.calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      {
        name: ReticleCommand.NAVIGATE,
        args: { url: 'http://localhost:3000/orgs/o-deleted/cases/c-deleted/notes' },
      },
    ]);
  });

  it('takes the id from another section under a hash router', async () => {
    const { calls, session } = tab('http://localhost:3000/#/cases/c-42/files');
    await arriveAtStartPath(
      manager([session, successor('http://localhost:3000/#/cases/c-42/notes')]),
      session,
      {
        ...recordedOnDeletedCase(),
        startPath: '/#/cases/c-deleted/notes',
        requires: [{ kind: PredicateKind.ROUTE, pathname: '/#/cases/:id/notes' }],
      },
      5_000,
      instantClock(100),
    );
    expect(calls.filter((c) => c.name === ReticleCommand.NAVIGATE)).toEqual([
      { name: ReticleCommand.NAVIGATE, args: { url: 'http://localhost:3000/#/cases/c-42/notes' } },
    ]);
  });
});

describe('onRoute — is the tab on a declared route', () => {
  it.each([
    ['/cases/c-42/notes', '/cases/:id/notes', true],
    ['/cases/c-42/notes/', '/cases/:id/notes', true],
    ['/cases/c-42/notes?tab=open', '/cases/:id/notes', true],
    ['/cases/c-42/files', '/cases/:id/notes', false],
    ['/cases/notes', '/cases/:id/notes', false],
    ['/cases/c-42/notes/extra', '/cases/:id/notes', false],
    ['/cases//notes', '/cases/:id/notes', false],
    ['/#/cases/c-42/notes', '/#/cases/:id/notes', true],
    ['/cases/%C3%A9t%C3%A9/notes', '/cases/:id/notes', true],
    ['/orders', '/orders', true],
    ['/orders?tab=wrap', '/orders?tab=summary', false],
    ['/settings', '/orders', false],
  ])('%s on %s is %s', (observed, route, expected) => {
    expect(onRoute(observed, route)).toBe(expected);
  });
});
