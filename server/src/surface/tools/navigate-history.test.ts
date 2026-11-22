/**
 * `reticle_navigate { history: "back" | "forward" }` moves the tab through its history and says
 * where the tab arrived (#1844).
 *
 * The page is a real Session from `createFakeSession`. Its `command` stands in for the SDK: on the
 * `history` command it moves `url` the way a popstate's `route.change` does, or it does not move,
 * or it refuses. The arrival wait itself is tested in `history-arrival.test.ts`; these tests hold
 * what the tool sends, and how it reports each answer.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HISTORY_DIRECTION_ARG,
  NavigateHistory,
  NavigateHistoryRefusal,
  ReticleCommand,
  ProductionRule,
  ReticleTool,
  productionRefusal,
} from '@reticlehq/core';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { createFakeSession } from '@/portal/session/fake-session.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { HistoryNavigateMessage } from './act/navigation/history-result.js';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';

const CART = 'http://localhost:3000/cart';
const ORDERS = 'http://localhost:3000/orders';

type PageAnswer = { moveTo: string } | { stay: true } | { refuse: NavigateHistoryRefusal };

interface Harness {
  readonly session: Session;
  readonly sent: { name: string; args: Record<string, unknown> | undefined }[];
  readonly deps: ToolDeps;
}

/** One connected tab on /cart. The page answers the `history` command as `answer` says. */
function harness(answer: PageAnswer): Harness {
  const sent: Harness['sent'] = [];
  const session = createFakeSession({}, { url: CART });
  session.command = (name: string, args?: Record<string, unknown>) => {
    sent.push({ name, args });
    if ('refuse' in answer) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { ok: false, reason: answer.refuse },
      });
    }
    if ('moveTo' in answer) {
      session.url = answer.moveTo;
    }
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: { ok: true } });
  };
  const sessions = {
    resolve: () => session,
    get: (id: string) => (id === session.id ? session : undefined),
    all: () => [session],
    count: () => 1,
  } as unknown as SessionManager;
  const deps = {
    sessions,
    pool: undefined,
    recordings: new RecordingStore(),
    now: () => 0,
  } as unknown as ToolDeps;
  return { session, sent, deps };
}

const navigate = (
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  (TOOLS.find((t) => t.name === ReticleTool.NAVIGATE) as ToolDef).handler(deps, args) as Promise<
    Record<string, unknown>
  >;

const historyCommands = (h: Harness): Harness['sent'] =>
  h.sent.filter((c) => ReticleCommand.HISTORY === c.name);

describe('reticle_navigate { history }', () => {
  it('sends Back to the page and reports the URL the tab arrived at', async () => {
    const h = harness({ moveTo: ORDERS });
    const result = await navigate(h.deps, { history: NavigateHistory.BACK, timeout_ms: 1_000 });

    expect(historyCommands(h)).toEqual([
      { name: ReticleCommand.HISTORY, args: { [HISTORY_DIRECTION_ARG]: NavigateHistory.BACK } },
    ]);
    expect(result).toEqual({
      ok: true,
      history: NavigateHistory.BACK,
      confirmed: true,
      url: ORDERS,
      sessionId: h.session.id,
    });
  });

  it('sends Forward the same way', async () => {
    const h = harness({ moveTo: ORDERS });
    const result = await navigate(h.deps, { history: NavigateHistory.FORWARD, timeout_ms: 1_000 });

    expect(historyCommands(h)).toEqual([
      { name: ReticleCommand.HISTORY, args: { [HISTORY_DIRECTION_ARG]: NavigateHistory.FORWARD } },
    ]);
    expect(result['confirmed']).toBe(true);
    expect(result['url']).toBe(ORDERS);
  });

  it('moves the verdict floor before the page goes away, as every other navigation does', async () => {
    // A later assert must not judge the requests of the page this move left behind.
    const h = harness({ moveTo: ORDERS });
    const floor = vi.spyOn(h.session.lastAct, 'markNavigated');
    await navigate(h.deps, { history: NavigateHistory.BACK, timeout_ms: 1_000 });
    expect(floor).toHaveBeenCalledTimes(1);
  });

  it('passes on the page refusal when there is no entry in that direction, and does not wait', async () => {
    const h = harness({ refuse: NavigateHistoryRefusal.NO_ENTRY });
    const result = await navigate(h.deps, { history: NavigateHistory.BACK, timeout_ms: 60_000 });

    expect(result).toEqual({
      ok: false,
      history: NavigateHistory.BACK,
      reason: NavigateHistoryRefusal.NO_ENTRY,
    });
  });

  it('says the move was not seen when the tab never left, with the budget it waited', async () => {
    const h = harness({ stay: true });
    const result = await navigate(h.deps, { history: NavigateHistory.BACK, timeout_ms: 0 });

    expect(result['ok']).toBe(true);
    expect(result['confirmed']).toBe(false);
    expect(result['waitedMs']).toBe(0);
    expect(result['url']).toBeUndefined();
    expect(result['note']).toBe(HistoryNavigateMessage.NOT_SEEN);
  });

  it('refuses history together with a url, and sends nothing', async () => {
    const h = harness({ moveTo: ORDERS });
    const result = await navigate(h.deps, { history: NavigateHistory.BACK, url: ORDERS });

    expect(result).toEqual({ ok: false, reason: HistoryNavigateMessage.ONE_KIND });
    expect(h.sent).toEqual([]);
  });

  it('refuses history together with reload, and sends nothing', async () => {
    const h = harness({ moveTo: ORDERS });
    const result = await navigate(h.deps, { history: NavigateHistory.BACK, reload: true });

    expect(result).toEqual({ ok: false, reason: HistoryNavigateMessage.ONE_KIND });
    expect(h.sent).toEqual([]);
  });

  it('refuses a direction that is not back or forward, and sends nothing', async () => {
    const h = harness({ moveTo: ORDERS });
    const result = await navigate(h.deps, { history: 'sideways' });

    expect(result).toEqual({ ok: false, reason: NavigateHistoryRefusal.UNKNOWN_DIRECTION });
    expect(h.sent).toEqual([]);
  });
});

const LEASE = 'lease-1';
const LEASED_CART = `http://localhost:3000/cart?__reticle_session=${LEASE}`;
const LEASED_ORDERS = `http://localhost:3000/orders?__reticle_session=${LEASE}`;
const PICTURE = 'http://localhost:3000/shots/cart.png';

/** What the browser does when the pool moves the leased page. */
type BrowserMove = { to: string; sdkBack: boolean } | { fails: true } | { stays: true };

interface LeaseHarness {
  readonly moves: string[];
  readonly deps: ToolDeps;
}

/**
 * A lease, connected or not, whose browser page is at `startUrl`. `onSdkMove` is what happens when
 * the SDK takes the `history` command; `onBrowserMove` is what happens when the pool moves the page.
 */
function leaseHarness(opts: {
  connected: boolean;
  startUrl: string;
  onSdkMove?: { to: string; sdkGone: boolean };
  onBrowserMove?: BrowserMove;
  /** A production drive guards this lease's requests. */
  guarded?: boolean;
}): LeaseHarness {
  const moves: string[] = [];
  let attached = opts.connected;
  let pageUrl = opts.startUrl;
  const session = createFakeSession({}, { sessionId: LEASE, url: LEASED_CART });
  session.command = (name: string) => {
    if (ReticleCommand.HISTORY === name && opts.onSdkMove !== undefined) {
      pageUrl = opts.onSdkMove.to;
      attached = !opts.onSdkMove.sdkGone;
    }
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: { ok: true } });
  };
  const sessions = {
    resolve: () => {
      if (!attached) {
        throw new Error(`no connected session with id '${LEASE}'`);
      }
      return session;
    },
    get: (id: string) => (attached && id === LEASE ? session : undefined),
    all: () => (attached ? [session] : []),
    count: () => (attached ? 1 : 0),
  } as unknown as SessionManager;
  const pool = {
    leaseUrl: (id: string) => (id === LEASE ? LEASED_CART : undefined),
    leasePageUrl: (id: string) => (id === LEASE ? pageUrl : undefined),
    leaseGuarded: (id: string) => id === LEASE && true === opts.guarded,
    historyLease: (id: string, direction: string) => {
      moves.push(`${id}:${direction}`);
      const move = opts.onBrowserMove;
      if (move === undefined || 'fails' in move) {
        return Promise.resolve(false);
      }
      if ('to' in move) {
        pageUrl = move.to;
        attached = move.sdkBack;
        session.url = move.to;
      }
      return Promise.resolve(true);
    },
  };
  const deps = {
    sessions,
    pool,
    recordings: new RecordingStore(),
    now: () => 0,
  } as unknown as ToolDeps;
  return { moves, deps };
}

describe('reticle_navigate { history } on a lease whose page has no SDK', () => {
  it('moves the page through the browser, and confirms when the SDK reattaches', async () => {
    const h = leaseHarness({
      connected: false,
      startUrl: PICTURE,
      onBrowserMove: { to: LEASED_ORDERS, sdkBack: true },
    });
    const result = await navigate(h.deps, {
      history: NavigateHistory.BACK,
      sessionId: LEASE,
      timeout_ms: 1_000,
    });

    expect(h.moves).toEqual([`${LEASE}:${NavigateHistory.BACK}`]);
    expect(result).toEqual({
      ok: true,
      history: NavigateHistory.BACK,
      confirmed: true,
      url: LEASED_ORDERS,
      sessionId: LEASE,
    });
  });

  it('names where the browser went when no SDK came back there', async () => {
    const h = leaseHarness({
      connected: false,
      startUrl: LEASED_ORDERS,
      onBrowserMove: { to: PICTURE, sdkBack: false },
    });
    const result = await navigate(h.deps, {
      history: NavigateHistory.FORWARD,
      sessionId: LEASE,
      timeout_ms: 200,
    });

    expect(result).toEqual({
      ok: true,
      history: NavigateHistory.FORWARD,
      confirmed: false,
      url: PICTURE,
      waitedMs: 200,
      note: HistoryNavigateMessage.LEFT_APP,
    });
  });

  it('says the move was not seen when the browser stayed on the same page', async () => {
    // Forward with no entry: Playwright returns without moving, and nothing changed.
    const h = leaseHarness({ connected: false, startUrl: PICTURE, onBrowserMove: { stays: true } });
    const result = await navigate(h.deps, {
      history: NavigateHistory.FORWARD,
      sessionId: LEASE,
      timeout_ms: 0,
    });

    expect(result['confirmed']).toBe(false);
    expect(result['url']).toBeUndefined();
    expect(result['note']).toBe(HistoryNavigateMessage.NOT_SEEN);
  });

  it('refuses when the browser does not move the page', async () => {
    const h = leaseHarness({ connected: false, startUrl: PICTURE, onBrowserMove: { fails: true } });
    const result = await navigate(h.deps, {
      history: NavigateHistory.BACK,
      sessionId: LEASE,
      timeout_ms: 0,
    });

    expect(result).toEqual({
      ok: false,
      history: NavigateHistory.BACK,
      reason: HistoryNavigateMessage.LEASE_DID_NOT_MOVE,
    });
  });
});

describe('reticle_navigate { history } on a lease whose SDK is connected', () => {
  it('moves through the SDK, and reads from the browser where a tab with no SDK went', async () => {
    // Back from the first app page goes to the about:blank the lease was opened on. The SDK is
    // gone and no session comes back, so only the browser can say where the tab is.
    const h = leaseHarness({
      connected: true,
      startUrl: LEASED_CART,
      onSdkMove: { to: 'about:blank', sdkGone: true },
    });
    const result = await navigate(h.deps, {
      history: NavigateHistory.BACK,
      sessionId: LEASE,
      timeout_ms: 200,
    });

    expect(h.moves).toEqual([]);
    expect(result).toEqual({
      ok: true,
      history: NavigateHistory.BACK,
      confirmed: false,
      url: 'about:blank',
      waitedMs: 200,
      note: HistoryNavigateMessage.LEFT_APP,
    });
  });
});

describe('reticle_navigate { history } on a production lease whose page has no SDK', () => {
  it('refuses, and does not move the page through the browser', async () => {
    // The move through the browser does not pass the daemon's command gate, where a production
    // drive refuses a history move. So the tool refuses it here, before the browser moves.
    const h = leaseHarness({
      connected: false,
      startUrl: PICTURE,
      onBrowserMove: { to: LEASED_ORDERS, sdkBack: true },
      guarded: true,
    });
    const result = await navigate(h.deps, {
      history: NavigateHistory.BACK,
      sessionId: LEASE,
      timeout_ms: 0,
    });

    expect(h.moves).toEqual([]);
    expect(result).toEqual({
      ok: false,
      history: NavigateHistory.BACK,
      reason: productionRefusal(ProductionRule.HISTORY_MOVE),
    });
  });
});
