/**
 * #2155: a dev server that compiles the start page for longer than the step budget.
 *
 * An app that connects Reticle from a dynamic import has a `complete` document while the dev server
 * still compiles the module that dials. Replay asked only `document.readyState`, read the page as
 * loaded, and reported it lost at the 5 s budget. The module request that is still open is the
 * evidence that the page is loading, and the lease's page sees it.
 */

import { describe, expect, it } from 'vitest';
import { FLOW_FILE_VERSION, type CommandResult, type FlowFile } from '@reticlehq/core';
import { arriveAtStartPath } from './flow-start-path.js';
import { pageLoading } from '@/portal/pool/pool-lease.js';
import type { PooledPage } from '@/portal/pool/pool-contract.js';
import { trackCodeFetches } from '@/portal/pool/code-fetch-tracker.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';

/** The module that dials Reticle: the dev server answers it this long after the navigation. */
const COMPILE_MS = 12_000;

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

/**
 * A dev server tab on a fake clock. The document is `complete` at once. The module that dials is
 * one script request that the dev server answers after `COMPILE_MS`; the SDK connects then.
 */
function devServerTab(): {
  sessions: SessionManager;
  page: PooledPage;
  clock: { now: () => number; sleep: (ms: number) => Promise<void> };
} {
  let t = 0;
  const now = (): number => t;
  const tracker = trackCodeFetches(now);
  const dialModule = {};
  tracker.started(dialModule, 'script');
  const clock = {
    now,
    sleep: (ms: number): Promise<void> => {
      t += ms;
      if (COMPILE_MS <= t) {
        tracker.ended(dialModule);
      }
      return Promise.resolve();
    },
  };
  const page = {
    goto: () => Promise.resolve(undefined),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
    evaluate: (script: string) =>
      Promise.resolve('document.readyState' === script ? 'complete' : undefined),
    fetchingCode: () => tracker.fetching(),
  } as PooledPage;
  const sessions = {
    resolve: () => (COMPILE_MS <= t ? successor : tab) as Session,
  } as unknown as SessionManager;
  return { sessions, page, clock };
}

describe('arriveAtStartPath on a dev server that compiles past the step budget (#2155)', () => {
  it('waits for a page whose module that dials is still being compiled', async () => {
    const { sessions, page, clock } = devServerTab();
    const arrived = await arriveAtStartPath(sessions, tab, flow, undefined, clock, () =>
      pageLoading(page),
    );
    expect(arrived.lost).toBeUndefined();
    expect(arrived.session?.id).toBe('fresh');
    expect(arrived.wait?.stillLoading).toBe(true);
    // A bound, not a duration: the wait went past the 5 s budget and stayed under the 30 s cap.
    expect(arrived.wait?.waitedMs).toBeGreaterThan(arrived.wait?.budgetMs ?? Infinity);
    expect(arrived.wait?.waitedMs).toBeLessThan(30_000);
  });

  it('still asks the document once no code is in flight', async () => {
    const page = {
      goto: () => Promise.resolve(undefined),
      close: () => Promise.resolve(),
      onCrash: () => undefined,
      evaluate: () => Promise.resolve('interactive'),
      fetchingCode: () => false,
    } as PooledPage;
    expect(await pageLoading(page)).toBe(true);
  });

  it('reads a complete page with no code in flight as loaded', async () => {
    const page = {
      goto: () => Promise.resolve(undefined),
      close: () => Promise.resolve(),
      onCrash: () => undefined,
      evaluate: () => Promise.resolve('complete'),
      fetchingCode: () => false,
    } as PooledPage;
    expect(await pageLoading(page)).toBe(false);
  });
});
