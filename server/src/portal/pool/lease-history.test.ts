/**
 * A leased page moves through its history in the browser (#1844).
 *
 * A lease whose page has no Reticle SDK (it went to an image, a PDF, another site, or back to the
 * `about:blank` the browser opened it on) cannot take the page's `history` command. The browser can
 * still move it, as `gotoLease` navigates it. And when the SDK cannot say where the tab went, the
 * browser can: `leasePageUrl` reads it.
 */
import { describe, expect, it, vi } from 'vitest';
import { NavigateHistory } from '@reticlehq/core';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledPage } from './browser-pool.js';

const APP = 'http://app.test/';

/** A launcher whose one page is `page`, over the minimum every page has. */
const launcher = (page: Partial<Record<keyof PooledPage, unknown>>): Launcher => {
  const full = {
    goto: () => Promise.resolve(),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
    ...page,
  } as PooledPage;
  return () =>
    Promise.resolve({
      newContext: () =>
        Promise.resolve({
          newPage: () => Promise.resolve(full),
          close: () => Promise.resolve(),
        }),
      close: () => Promise.resolve(),
      onDisconnected: (): void => undefined,
      isConnected: (): boolean => true,
    });
};

let seq = 0;
const ids = (): string => `lease-${String((seq += 1))}`;

async function leased(
  page: Partial<Record<keyof PooledPage, unknown>>,
): Promise<{ pool: BrowserPool; sessionId: string }> {
  const pool = new BrowserPool(launcher(page), { maxContexts: 1, genSessionId: ids });
  const { sessionId } = await pool.acquire(APP);
  return { pool, sessionId };
}

describe('historyLease', () => {
  it('moves the leased page back through the browser, inside the budget it was given', async () => {
    const goBack = vi.fn(() => Promise.resolve(null));
    const goForward = vi.fn(() => Promise.resolve(null));
    const { pool, sessionId } = await leased({ goBack, goForward });

    expect(await pool.historyLease(sessionId, NavigateHistory.BACK, 2_000)).toBe(true);
    expect(goBack).toHaveBeenCalledWith({ timeoutMs: 2_000 });
    expect(goForward).not.toHaveBeenCalled();
  });

  it('moves it forward the same way', async () => {
    const goBack = vi.fn(() => Promise.resolve(null));
    const goForward = vi.fn(() => Promise.resolve(null));
    const { pool, sessionId } = await leased({ goBack, goForward });

    expect(await pool.historyLease(sessionId, NavigateHistory.FORWARD, 2_000)).toBe(true);
    expect(goForward).toHaveBeenCalledTimes(1);
    expect(goBack).not.toHaveBeenCalled();
  });

  it('answers false for an id that is not a lease', async () => {
    const { pool } = await leased({ goBack: () => Promise.resolve(null) });
    expect(await pool.historyLease('not-a-lease', NavigateHistory.BACK, 2_000)).toBe(false);
  });

  it('answers false, not a move, for a page that cannot move through its history', async () => {
    // Same contract as hardReloadLease: a missing capability reads as "could not", never as done.
    const { pool, sessionId } = await leased({});
    expect(await pool.historyLease(sessionId, NavigateHistory.BACK, 2_000)).toBe(false);
  });

  it('answers false when the browser fails the move', async () => {
    const { pool, sessionId } = await leased({
      goBack: () => Promise.reject(new Error('Timeout 2000ms exceeded')),
    });
    expect(await pool.historyLease(sessionId, NavigateHistory.BACK, 2_000)).toBe(false);
  });
});

describe('leasePageUrl', () => {
  it('reads where the leased page is from the browser', async () => {
    const { pool, sessionId } = await leased({ url: () => 'about:blank' });
    expect(pool.leasePageUrl(sessionId)).toBe('about:blank');
  });

  it('is undefined for an id that is not a lease, and for a page that cannot say', async () => {
    const { pool, sessionId } = await leased({});
    expect(pool.leasePageUrl(sessionId)).toBeUndefined();
    expect(pool.leasePageUrl('not-a-lease')).toBeUndefined();
  });
});
