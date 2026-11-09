/**
 * A lease reaches its page's JS coverage, and can ask for it before the page's first script.
 *
 * The pool only routes: the launcher starts coverage on the page when the context was opened with
 * `jsCoverage`, and the coverage tool reads it through `coverageOf`, by the id the agent holds.
 */
import { describe, expect, it } from 'vitest';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledPage } from './browser-pool.js';
import type { PooledCoverage } from './pool-contract.js';

const coverage: PooledCoverage = {
  start: () => Promise.resolve(true),
  take: () => Promise.resolve([]),
};

function launcher(contextOpts: unknown[], page: Partial<PooledPage>): Launcher {
  const full = {
    goto: () => Promise.resolve(),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
    ...page,
  };
  return () =>
    Promise.resolve({
      newContext: (opts?: unknown) => {
        contextOpts.push(opts);
        return Promise.resolve({
          newPage: () => Promise.resolve(full),
          close: () => Promise.resolve(),
        });
      },
      close: () => Promise.resolve(),
      onDisconnected: (): void => undefined,
      isConnected: (): boolean => true,
    });
}

let seq = 0;
const ids = (): string => `lease-${String((seq += 1))}`;

describe('JS coverage on a lease', () => {
  it('asks the context for coverage before the first script only when the lease asked for it', async () => {
    const opts: unknown[] = [];
    const pool = new BrowserPool(launcher(opts, { jsCoverage: coverage }), {
      maxContexts: 2,
      genSessionId: ids,
    });
    await pool.acquire('http://app.test/', { jsCoverage: true });
    await pool.acquire('http://app.test/');
    expect(opts[0]).toEqual({ jsCoverage: true });
    expect(opts[1]).toBeUndefined();
  });

  it('hands the page coverage to the id the agent holds, alias included', async () => {
    const pool = new BrowserPool(launcher([], { jsCoverage: coverage }), {
      maxContexts: 2,
      genSessionId: ids,
    });
    const lease = await pool.acquire('http://app.test/');
    pool.alias('app-named', lease.sessionId);
    expect(pool.coverageOf(lease.sessionId)).toBe(coverage);
    expect(pool.coverageOf('app-named')).toBe(coverage);
    expect(pool.coverageOf('not-a-lease')).toBeUndefined();
  });

  it('answers undefined for a page that cannot measure, never an empty coverage', async () => {
    const pool = new BrowserPool(launcher([], {}), { maxContexts: 2, genSessionId: ids });
    const lease = await pool.acquire('http://app.test/');
    expect(pool.coverageOf(lease.sessionId)).toBeUndefined();
  });
});
