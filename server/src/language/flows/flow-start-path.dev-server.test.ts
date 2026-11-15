/**
 * #2155: a dev server that compiles the start page for longer than the step budget.
 *
 * An app that connects Reticle from a dynamic import has a `complete` document while the dev server
 * still compiles the module that dials. A pool lease asked only `document.readyState`, read the page
 * as loaded, and replay reported "no page was connected" at the 5 s budget. That is the path of the
 * report: `reticle_verify { action: "flows", parallel: N }` runs each flow on a lease. The request
 * that is still open is the evidence that the page is loading, and the lease's page sees it.
 *
 * The same wait must also end. A page that runs an endless loop never answers `page.evaluate`, and
 * an unbounded question held replay forever.
 */

import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { FLOW_FILE_VERSION, type CommandResult, type FlowFile } from '@reticlehq/core';
import { arriveAtStartPath, type StartPathArrival } from './flow-start-path.js';
import { BrowserPool } from '@/portal/pool/browser-pool.js';
import type { Launcher, PooledBrowser, PooledContext } from '@/portal/pool/pool-contract.js';
import { watchPageRequests } from '@/portal/pool/page-requests.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';

/** The module that dials Reticle: the dev server answers it this long after the navigation. */
const COMPILE_MS = 12_000;
const LOST = 'no page was connected';
/** Generous: the frozen-page tests ask a page that never answers, a few times, on real time. */
const FROZEN_TEST_TIMEOUT_MS = 20_000;

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: 'builder',
  createdAt: 0,
  steps: [],
  startPath: '/builder',
};

const tab = {
  id: 'old',
  url: 'http://127.0.0.1:8001/home',
  eventsSince: (): never[] => [],
  command: (): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'n',
      ok: true,
      result: { ok: true },
    } as CommandResult),
};

const successor: Partial<Session> = {
  id: 'fresh',
  url: 'http://127.0.0.1:8001/builder',
  eventsSince: () => [],
};

/** A fake clock that the arrival loop moves with its own sleeps. `onTick` sees each new time. */
function fakeClock(onTick: (t: number) => void = () => undefined): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      t += ms;
      onTick(t);
      return Promise.resolve();
    },
  };
}

/** Sessions where the start page connects at `connectAt` on the clock. */
function sessionsConnectingAt(connectAt: number, now: () => number): SessionManager {
  return {
    resolve: () => (connectAt <= now() ? successor : tab) as Session,
  } as unknown as SessionManager;
}

/** One request of the page: its resource type, and when it starts and ends on the clock. */
interface HeldRequest {
  resourceType(): string;
  from: number;
  to: number;
}

const request = (type: string, from: number, to: number): HeldRequest => ({
  resourceType: () => type,
  from,
  to,
});

/** The page's requests, sent as Playwright `request` events when the clock reaches them. */
function devServerNetwork(requests: HeldRequest[]): {
  events: Pick<Page, 'on'>;
  advance: (t: number) => void;
} {
  const listeners = new Map<string, (sent: HeldRequest) => void>();
  const started = new Set<HeldRequest>();
  const ended = new Set<HeldRequest>();
  const on = (event: string, listener: (sent: HeldRequest) => void): void => {
    listeners.set(event, listener);
  };
  return {
    events: { on } as unknown as Pick<Page, 'on'>,
    advance: (t) => {
      for (const sent of requests) {
        if (!started.has(sent) && sent.from <= t) {
          started.add(sent);
          listeners.get('request')?.(sent);
        }
        if (started.has(sent) && !ended.has(sent) && sent.to <= t) {
          ended.add(sent);
          listeners.get('requestfinished')?.(sent);
        }
      }
    },
  };
}

/**
 * A pool lease on a fake browser. Its page is `complete` at once, and its requests come from
 * `network`, through the tracker that the real launcher attaches.
 */
async function leaseOnDevServer(
  network: ReturnType<typeof devServerNetwork>,
  now: () => number,
): Promise<{ pool: BrowserPool; sessionId: string }> {
  const context: PooledContext = {
    newPage: () => {
      const tracker = watchPageRequests(network.events, now);
      return Promise.resolve({
        goto: () => Promise.resolve(undefined),
        close: () => Promise.resolve(),
        onCrash: () => undefined,
        evaluate: (script: string) =>
          Promise.resolve('document.readyState' === script ? 'complete' : undefined),
        fetching: () => tracker.fetching(),
      });
    },
    close: () => Promise.resolve(),
  };
  const browser: PooledBrowser = {
    isConnected: () => true,
    newContext: () => Promise.resolve(context),
    close: () => Promise.resolve(),
    onDisconnected: () => undefined,
  };
  const launch: Launcher = () => Promise.resolve(browser);
  const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: () => 'lease-1', now });
  const lease = await pool.acquire('http://127.0.0.1:8001/home');
  network.advance(now());
  return { pool, sessionId: lease.sessionId };
}

/** Replay's arrival on a lease whose page makes `requests`, and connects at `connectAt`. */
async function arriveOnLease(
  requests: HeldRequest[],
  connectAt: number,
): Promise<StartPathArrival> {
  const network = devServerNetwork(requests);
  const clock = fakeClock((t) => {
    network.advance(t);
  });
  const { pool, sessionId } = await leaseOnDevServer(network, clock.now);
  return arriveAtStartPath(
    sessionsConnectingAt(connectAt, clock.now),
    tab,
    flow,
    undefined,
    clock,
    () => pool.leaseLoading(sessionId),
  );
}

describe('arriveAtStartPath on a lease whose dev server compiles past the step budget (#2155)', () => {
  it('waits for a page whose module that dials is still being compiled', async () => {
    const arrived = await arriveOnLease([request('script', 0, COMPILE_MS)], COMPILE_MS);
    expect(arrived.lost ?? '').not.toContain(LOST);
    expect(arrived.session?.id).toBe('fresh');
    expect(arrived.wait?.stillLoading).toBe(true);
    // A bound, not a duration: the wait went past the 5 s budget and stayed under the 30 s cap.
    expect(arrived.wait?.waitedMs).toBeGreaterThan(arrived.wait?.budgetMs ?? Infinity);
    expect(arrived.wait?.waitedMs).toBeLessThan(30_000);
  });

  /*
   * The gap case: the app awaits its data, past the budget, before it imports the module that
   * dials. While the data request is open, no module request is.
   */
  it('waits while the app awaits its data before it imports the module that dials', async () => {
    const arrived = await arriveOnLease(
      [request('fetch', 0, 8_000), request('script', 8_000, COMPILE_MS)],
      COMPILE_MS,
    );
    expect(arrived.lost ?? '').not.toContain(LOST);
    expect(arrived.session?.id).toBe('fresh');
  });

  it('names `signalTimeoutMs` when the page is still loading at the loading cap', async () => {
    const clock = fakeClock();
    const arrived = await arriveAtStartPath(
      sessionsConnectingAt(Infinity, clock.now),
      tab,
      flow,
      undefined,
      clock,
      () => Promise.resolve(true),
    );
    expect(arrived.lost).toContain(LOST);
    expect(arrived.lost).toContain('signalTimeoutMs');
    expect(arrived.wait?.stillLoading).toBe(true);
  });
});

describe('arriveAtStartPath on a page that does not answer (#2155)', () => {
  /** A probe on a page that runs an endless loop: `page.evaluate` never answers. */
  const frozen = (): Promise<boolean> => new Promise<boolean>(() => undefined);

  it(
    'ends with a result, and says that the page did not answer',
    async () => {
      const clock = fakeClock();
      // A short budget and cap: each question waits for its answer on real time.
      const arrived = await arriveAtStartPath(
        sessionsConnectingAt(Infinity, clock.now),
        tab,
        flow,
        1_000,
        clock,
        frozen,
        1_500,
      );
      expect(arrived.lost).toContain(LOST);
      expect(arrived.lost).toContain('did not answer');
    },
    FROZEN_TEST_TIMEOUT_MS,
  );

  it(
    'keeps waiting for a busy page that does not answer, and continues when it connects',
    async () => {
      const clock = fakeClock();
      const arrived = await arriveAtStartPath(
        sessionsConnectingAt(1_300, clock.now),
        tab,
        flow,
        1_000,
        clock,
        frozen,
      );
      expect(arrived.lost).toBeUndefined();
      expect(arrived.session?.id).toBe('fresh');
    },
    FROZEN_TEST_TIMEOUT_MS,
  );
});
