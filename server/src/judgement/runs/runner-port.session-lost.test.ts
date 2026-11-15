/**
 * #2060: `reticle verify` must see that a flow left the app on a page with no session, say the URL
 * of that page, and open the app again for the next flow. This is the live port's half: it pins
 * the tab that the run drives, reads that tab's session and the driven page, and opens the page
 * again. ReticleRunner decides what the run reports.
 *
 * Review of #2261: with the user's own tab of the app connected, the port counted that tab as the
 * run's session. The driven page's loss was not reported, and the later flows clicked in the
 * user's tab and passed. The tests below with two tabs show that defect on the first fix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  EventType,
  NO_SESSION_CONNECTED_ERROR,
  ReplayStatus,
  type ReticleEvent,
} from '@reticlehq/core';
import { createRunnerPort, drivenPageNoSessionReason } from '@/judgement/runs/runner-port.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import type { DrivenPage } from '@/portal/input/driven-page.js';
import { fakeHello } from '@/portal/session/fake-session.js';
import { Session } from '@/portal/session/session.js';
import { SessionManager } from '@/portal/session/session-manager.js';

const replayed = vi.hoisted(() => ({ args: [] as Record<string, unknown>[] }));

// The replay itself is not under test here: only which tab the port asks it to drive.
vi.mock('@/language/flows/flow-learning.js', () => ({
  replayAndLearn: (_deps: unknown, args: Record<string, unknown>) => {
    replayed.args.push(args);
    return Promise.resolve({ name: String(args['flowName']), status: 'ok', steps: [] });
  },
}));
// A flow with no step timeouts: its start page budget is the replay floor. The flow named
// UNSAVED is not in the store.
vi.mock('@/language/flows/flow-store-for-session.js', () => ({
  flowsForSession: () => ({
    flows: {
      list: () => Promise.resolve(['a']),
      load: (name: string) =>
        Promise.resolve(
          'unsaved' === name
            ? { ok: false, code: 'flow_not_found' }
            : { ok: true, value: { version: 2, name, steps: [] } },
        ),
    },
  }),
}));
vi.mock('@/surface/tools/session-ports.js', () => ({
  flowStartState: () => () => Promise.resolve(undefined),
}));

const ORIGIN = 'http://localhost:3000';
const START = `${ORIGIN}/`;
const DEAD = `${ORIGIN}/stats?id=missing`;
const DRIVEN = 's-driven';
const USERS = 's-users-tab';

function tab(id: string, url = START): Session {
  const session = new Session(
    { ...fakeHello(), sessionId: id, url },
    { send: (): void => {} } as unknown as WebSocket,
    () => 0,
  );
  session.touch();
  session.applyHealth(false, true);
  return session;
}

/**
 * The driven page. `sdk` answers hasSdk(), `dead` answers deadEnd() (an HTTP error status or
 * another origin), and `id` is the session id in its session store.
 */
interface FakePage {
  url: string;
  id: string | undefined;
  sdk: boolean | undefined;
  dead: boolean;
  reopens: number;
}

function app(opts: { page?: FakePage; sessionId?: string } = {}) {
  const sessions = new SessionManager();
  const clock: { t: number; slept: number; onSleep?: () => void } = { t: 0, slept: 0 };
  const page = opts.page;
  const driven: DrivenPage | undefined =
    page === undefined
      ? undefined
      : {
          url: () => page.url,
          sessionId: () => Promise.resolve(page.id),
          hasSdk: () => Promise.resolve(page.sdk),
          deadEnd: () => Promise.resolve(page.dead),
          reopen: () => {
            page.reopens += 1;
            return Promise.resolve(true);
          },
        };
  let resolves = 0;
  const counted = new Proxy(sessions, {
    get(target, prop): unknown {
      if ('resolve' === prop) {
        resolves += 1;
      }
      const value: unknown = Reflect.get(target, prop, target);
      return 'function' === typeof value ? (value as () => unknown).bind(target) : value;
    },
  });
  const deps = {
    sessions: counted,
    realInput: {
      isAvailableFor: () => Promise.resolve(true),
      ...(driven === undefined ? {} : { drivenPage: () => driven }),
    },
    now: () => clock.t,
  } as unknown as ToolDeps;
  // The wait moves this clock, so a wait ends without a real timer.
  const sleep = (ms: number): Promise<void> => {
    clock.t += ms;
    clock.slept += ms;
    clock.onSleep?.();
    return Promise.resolve();
  };
  const port = createRunnerPort(deps, opts.sessionId, { sleep });
  return { sessions, port, clock, resolves: () => resolves };
}

const drivenPage = (): FakePage => ({ url: START, id: DRIVEN, sdk: true, dead: false, reopens: 0 });

/** The driven page went to a server's 404 page: no SDK, and an HTTP error status. */
function goneToDeadPage(page: FakePage): void {
  page.url = DEAD;
  page.sdk = false;
  page.dead = true;
}

beforeEach(() => {
  replayed.args.length = 0;
});

describe('the live port after a flow (#2060)', () => {
  // Each call below is optional on RunnerPort. An absent method would make every check vacuous.
  it('has the methods that the runner calls between flows', () => {
    const { port } = app();
    for (const method of ['startRun', 'sessionLost', 'sessionBack', 'reopen'] as const) {
      expect(typeof port[method]).toBe('function');
    }
  });

  it('reports no loss while the tab of the run is connected', async () => {
    const page = drivenPage();
    const { sessions, port } = app({ page });
    sessions.add(tab(DRIVEN));
    await port.replayFlow('a');
    await expect(port.sessionLost?.()).resolves.toBeUndefined();
  });

  it('names the URL of a dead-end page at once, with no wait', async () => {
    const page = drivenPage();
    const { sessions, port, clock } = app({ page });
    const driven = tab(DRIVEN);
    sessions.add(driven);
    await port.replayFlow('a');
    sessions.remove(driven);
    goneToDeadPage(page);
    await expect(port.sessionLost?.()).resolves.toEqual({ lastUrl: DEAD });
    // A fact about the page, not a timer.
    expect(clock.slept).toBe(0);
  });

  // Review of #2261: a module script or a dynamic import loads the SDK after the document has
  // loaded. "No SDK global yet" was taken as a lost session, and the page was loaded again.
  // Second review of #2261: the last step of a flow goes to the dead page, and the check runs
  // before the old document's socket has closed. The tab still looked connected, the loss was
  // missed, and the next flow got the blame. The page now in the tab has no SDK, so a session
  // under the pin cannot be its own.
  it("reports the loss at once when the flow's last step went to a dead page", async () => {
    const page = drivenPage();
    const { sessions, port, clock } = app({ page });
    sessions.add(tab(DRIVEN));
    await port.replayFlow('a');
    // The old document's session is still in the map.
    goneToDeadPage(page);
    await expect(port.sessionLost?.()).resolves.toEqual({ lastUrl: DEAD });
    expect(clock.slept).toBe(0);
  });

  it('does not trust an open socket while the page in the tab has no SDK', async () => {
    const page = drivenPage();
    const { sessions, port, clock } = app({ page });
    const old = tab(DRIVEN);
    sessions.add(old);
    await port.replayFlow('a');
    page.url = DEAD;
    page.sdk = false;
    // The old socket closes during the wait, and no SDK comes on the new page.
    clock.onSleep = () => {
      sessions.remove(old);
    };
    await expect(port.sessionLost?.()).resolves.toEqual({ lastUrl: DEAD });
    expect(clock.slept).toBeGreaterThan(0);
  });

  // A flow that is not in the store still gets the start-page floor. A wait of 0 reported a late
  // SDK as a lost session.
  it('waits for a late SDK also after a flow that the store cannot load', async () => {
    const page = drivenPage();
    const { sessions, port, clock } = app({ page });
    const driven = tab(DRIVEN);
    sessions.add(driven);
    await port.replayFlow('unsaved');
    sessions.remove(driven);
    page.sdk = false;
    clock.onSleep = () => {
      if (sessions.get(DRIVEN) === undefined) {
        page.sdk = true;
        sessions.add(tab(DRIVEN));
      }
    };
    await expect(port.sessionLost?.()).resolves.toBeUndefined();
  });

  it('waits for a healthy page whose SDK loads late, and reports no loss when it connects', async () => {
    const page = drivenPage();
    const { sessions, port, clock } = app({ page });
    const driven = tab(DRIVEN);
    sessions.add(driven);
    await port.replayFlow('a');
    sessions.remove(driven);
    page.url = `${START}other`;
    page.sdk = false;
    clock.onSleep = () => {
      if (sessions.get(DRIVEN) === undefined) {
        page.sdk = true;
        sessions.add(tab(DRIVEN));
      }
    };
    await expect(port.sessionLost?.()).resolves.toBeUndefined();
    await expect(port.reopen?.()).resolves.toBe(true);
    expect(clock.slept).toBeGreaterThan(0);
  });

  it('reports a page with no SDK and no error status only after the start-page wait', async () => {
    const page = drivenPage();
    const { sessions, port, clock } = app({ page });
    const driven = tab(DRIVEN);
    sessions.add(driven);
    await port.replayFlow('a');
    sessions.remove(driven);
    page.url = DEAD;
    page.sdk = false;
    await expect(port.sessionLost?.()).resolves.toEqual({ lastUrl: DEAD });
    expect(clock.slept).toBeGreaterThan(0);
  });

  it('reports no loss while the driven page has the SDK: its session can still connect', async () => {
    const page = drivenPage();
    const { sessions, port } = app({ page });
    const driven = tab(DRIVEN);
    sessions.add(driven);
    await port.replayFlow('a');
    sessions.remove(driven);
    await expect(port.sessionLost?.()).resolves.toBeUndefined();
    await expect(port.sessionBack?.()).resolves.toBe(true);
  });

  it('looks for the session without resolve(), so the check marks no agent activity', async () => {
    const page = drivenPage();
    const { sessions, port, resolves } = app({ page });
    sessions.add(tab(USERS));
    await port.sessionLost?.();
    await port.sessionBack?.();
    expect(resolves()).toBe(0);
  });

  it('opens the start URL again in the driven page, and does not wait for a session', async () => {
    const page = drivenPage();
    const { sessions, port, clock } = app({ page });
    sessions.add(tab(DRIVEN));
    await port.replayFlow('a');
    await expect(port.reopen?.()).resolves.toBe(true);
    expect(page.reopens).toBe(1);
    expect(clock.slept).toBe(0);
  });
});

describe("the live port with the user's own tab of the app connected", () => {
  it("replays in the driven page's own tab, not in the user's tab", async () => {
    const page = drivenPage();
    const { sessions, port } = app({ page });
    sessions.add(tab(USERS));
    sessions.add(tab(DRIVEN));
    await port.replayFlow('a');
    expect(replayed.args[0]?.['sessionId']).toBe(DRIVEN);
  });

  it("reports the driven page's loss, although the user's tab is connected", async () => {
    const page = drivenPage();
    const { sessions, port } = app({ page });
    const driven = tab(DRIVEN);
    sessions.add(driven);
    sessions.add(tab(USERS));
    await port.replayFlow('a');
    sessions.remove(driven);
    goneToDeadPage(page);
    await expect(port.sessionLost?.()).resolves.toEqual({ lastUrl: DEAD });
    await expect(port.sessionBack?.()).resolves.toBe(false);
  });

  // The successor rule leaves out the tabs that were open before the driven tab left. It can still
  // choose the one tab at the same origin that connected after that: here the user's tab, which is
  // not the driven page.
  it("does not take a user's tab that connects later for the driven page's successor", async () => {
    const page = drivenPage();
    const { sessions, port } = app({ page });
    const driven = tab(DRIVEN);
    sessions.add(driven);
    await port.replayFlow('a');
    sessions.remove(driven);
    sessions.add(tab(USERS));
    goneToDeadPage(page);
    await expect(port.sessionLost?.()).resolves.toEqual({ lastUrl: DEAD });
  });

  it("does not replay in the user's tab while the driven page has no session", async () => {
    const page = drivenPage();
    const { sessions, port, clock } = app({ page });
    const driven = tab(DRIVEN);
    sessions.add(driven);
    await port.replayFlow('a');
    sessions.remove(driven);
    sessions.add(tab(USERS));
    replayed.args.length = 0;
    const replay = await port.replayFlow('b');
    expect(replayed.args).toEqual([]);
    expect(replay.status).toBe(ReplayStatus.UNVERIFIABLE);
    expect(replay.unverifiable?.reason).toBe(drivenPageNoSessionReason(DRIVEN));
    // It waited for the driven page as replay waits for a start page, on the injected clock.
    expect(clock.slept).toBeGreaterThan(0);
  });

  // With no tab connected at all, the pinned id must not hide the daemon's diagnosis (the port
  // scan and the next action) behind "no connected session with id".
  it('gives the no-session diagnosis when no tab is connected at all', async () => {
    const page = drivenPage();
    const { sessions, port } = app({ page });
    const driven = tab(DRIVEN);
    sessions.add(driven);
    await port.replayFlow('a');
    sessions.remove(driven);
    replayed.args.length = 0;
    await expect(port.replayFlow('b')).rejects.toThrow(NO_SESSION_CONNECTED_ERROR);
    expect(replayed.args).toEqual([]);
  });

  it('replays once the driven page connects during that wait', async () => {
    const page = drivenPage();
    const { sessions, port, clock } = app({ page });
    const driven = tab(DRIVEN);
    sessions.add(driven);
    await port.replayFlow('a');
    sessions.remove(driven);
    sessions.add(tab(USERS));
    // The driven page connects while the port waits for it.
    clock.onSleep = () => {
      if (sessions.get(DRIVEN) === undefined) {
        sessions.add(tab(DRIVEN));
      }
    };
    replayed.args.length = 0;
    await port.replayFlow('b');
    expect(replayed.args[0]?.['sessionId']).toBe(DRIVEN);
  });

  // Other callers: with `--session-id`, or on `reticle serve --http`, the run's tab can be a
  // tab that is not the driven page. Then the reason must not name the driven page's URL, and the
  // port must not load the start URL in the driven page.
  it('names no URL of the driven page, and does not reload it, for a tab that is not that page', async () => {
    const page = drivenPage();
    const { sessions, port } = app({ page, sessionId: USERS });
    const users = tab(USERS);
    sessions.add(users);
    // On another origin, so the successor rule of replay cannot take it for the user's tab.
    sessions.add(tab(DRIVEN, 'http://localhost:4000/'));
    await port.replayFlow('a');
    expect(replayed.args[0]?.['sessionId']).toBe(USERS);
    sessions.remove(users);
    await expect(port.sessionLost?.()).resolves.toEqual({});
    await expect(port.reopen?.()).resolves.toBe(false);
    expect(page.reopens).toBe(0);
  });

  it('names where a tab that is not the driven page was heading, when the tab said so', async () => {
    const { sessions, port } = app({ sessionId: USERS });
    const users = tab(USERS);
    sessions.add(users);
    await port.replayFlow('a');
    users.pushEvent({
      type: EventType.NET_PENDING,
      data: { id: 'nav-1', method: 'GET', url: DEAD, initiator: 'navigation' },
    } as unknown as ReticleEvent);
    sessions.remove(users);
    await expect(port.sessionLost?.()).resolves.toEqual({ lastUrl: DEAD });
  });

  // One port serves every run of `reticle serve --http`. With no driven page, run 1 pins the only
  // tab. That tab leaves and another connects. Without startRun, run 2 kept the first pin, and the
  // successor rule took the new tab under the old id.
  it('forgets the tab of the last run when a run starts', async () => {
    const { sessions, port } = app();
    const first = tab('s-first-run');
    sessions.add(first);
    await port.replayFlow('a');
    expect(replayed.args[0]?.['sessionId']).toBe('s-first-run');
    sessions.remove(first);
    sessions.add(tab('s-next-run'));
    port.startRun?.();
    replayed.args.length = 0;
    await port.replayFlow('a');
    expect(replayed.args[0]?.['sessionId']).toBe('s-next-run');
  });
});

/*
 * Review of #2261: with no sessionId, resolve() also throws when two tabs are connected and none is
 * the clear winner. The HTTP verify path passes no sessionId, and the user's own tab can be
 * connected too. The first fix then said "no session after navigation", which was not true.
 */
describe('the live port with two connected tabs, no sessionId and no driven page', () => {
  it('reports no loss, because sessions are connected', async () => {
    const { sessions, port } = app();
    sessions.add(tab(DRIVEN));
    sessions.add(tab(USERS));
    // The setup is the ambiguous case: an id-less resolve() refuses it.
    expect(() => sessions.resolve()).toThrow('multiple sessions connected');
    await port.replayFlow('a');
    await expect(port.sessionLost?.()).resolves.toBeUndefined();
  });

  it('names no URL when the tab left and nothing says where it went', async () => {
    const { sessions, port } = app();
    const only = tab(DRIVEN);
    sessions.add(only);
    await port.replayFlow('a');
    sessions.remove(only);
    await expect(port.sessionLost?.()).resolves.toEqual({});
  });
});

/*
 * Second review of #2261: a loss was reported when no session had ever been connected. The reason
 * then said "the session was connected, then it dropped", and hid the daemon's diagnosis that
 * main gave (the port scan, a typo in --session-id).
 */
describe('the live port when the tab left before the flow started', () => {
  // The tab was not connected when flow b started. Its tombstone is the only sign that it was the
  // run's tab and that it left, so the loss is real.
  it('reports the loss from the tombstone alone', async () => {
    const { sessions, port } = app();
    const only = tab(DRIVEN);
    sessions.add(only);
    await port.replayFlow('a');
    sessions.remove(only);
    await expect(port.replayFlow('b')).rejects.toThrow(NO_SESSION_CONNECTED_ERROR);
    await expect(port.sessionLost?.()).resolves.toEqual({});
  });
});

describe('the live port when the run never had a session', () => {
  it('reports no loss when no tab was ever connected', async () => {
    const { port } = app();
    await port.replayFlow('a').catch(() => undefined);
    await expect(port.sessionLost?.()).resolves.toBeUndefined();
  });

  // Final review of #2261: the flag of the last flow stayed when the replay threw before it was set.
  it('does not keep the start state of the last flow when the replay throws', async () => {
    const { sessions, port } = app();
    const only = tab(DRIVEN);
    sessions.add(only);
    await port.replayFlow('a');
    // Gone with no tombstone, as a parked tab: nothing says that the run's tab was connected.
    sessions.park(only);
    await expect(port.replayFlow('b')).rejects.toThrow(NO_SESSION_CONNECTED_ERROR);
    await expect(port.sessionLost?.()).resolves.toBeUndefined();
  });

  it('reports no loss for a --session-id that never connected', async () => {
    const { sessions, port } = app({ sessionId: 's-typo' });
    sessions.add(tab(USERS));
    await port.replayFlow('a');
    await expect(port.sessionLost?.()).resolves.toBeUndefined();
  });
});
