/**
 * A lease can be resized, so mobile-only UI is reachable on the DEFAULT install.
 *
 * `reticle_viewport` consulted only the driven-provider path, which exists only when the daemon was
 * started with `--drive <url>` or `RETICLE_CDP_URL`. Neither is true of an SDK-only install — the
 * one `reticle init` produces — so the tool refused with `no-cdp-provider` for everybody, and the
 * recommendation printed alongside asked the reader to install a second browser.
 *
 * Reported from the field: mobile-only UI (a `lg:hidden` hamburger, a drawer that only mounts under
 * a breakpoint) could not be driven at a desktop viewport at all. The reporter got as far as
 * clicking the hidden-but-present control, which worked, but could not prove the nested drill-down
 * that only exists at a mobile width.
 *
 * A lease IS a Playwright-owned page. The resize was always possible; the tool had no route to it,
 * exactly as `reticle_network_mock` had none before it.
 */
import { describe, expect, it, vi } from 'vitest';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledPage } from './browser-pool.js';

const launcher = (page: Partial<Record<keyof PooledPage, unknown>> = {}): Launcher => {
  const full = {
    goto: () => Promise.resolve(),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
    setViewport: () => Promise.resolve(),
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
const poolWith = (page?: Partial<Record<keyof PooledPage, unknown>>): BrowserPool =>
  new BrowserPool(launcher(page), { maxContexts: 2, genSessionId: ids });

const MOBILE = { width: 390, height: 844 };

describe('resizing a leased page', () => {
  it('applies the size to the leased page', async () => {
    const setViewport = vi.fn(() => Promise.resolve());
    const pool = poolWith({ setViewport });
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.setViewportLease(lease.sessionId, MOBILE)).toBe(true);
    expect(setViewport).toHaveBeenCalledWith(MOBILE);
  });

  it('answers to the id the SDK registered, not only the lease key', async () => {
    const pool = poolWith();
    const lease = await pool.acquire('http://app.test/');
    pool.alias('s-registered', lease.sessionId);
    expect(
      await pool.setViewportLease('s-registered', MOBILE),
      'the agent is handed the registered id, so refusing it makes the tool unreachable',
    ).toBe(true);
  });

  it('reports FALSE for a page that cannot resize, rather than claiming it did', async () => {
    const pool = poolWith({ setViewport: undefined });
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.setViewportLease(lease.sessionId, MOBILE)).toBe(false);
  });

  it('reports FALSE when the resize throws, rather than surfacing the throw', async () => {
    const pool = poolWith({
      setViewport: () => Promise.reject(new Error('target closed')),
    });
    const lease = await pool.acquire('http://app.test/');
    expect(await pool.setViewportLease(lease.sessionId, MOBILE)).toBe(false);
  });

  it('reports FALSE for a session that is not a lease at all', async () => {
    expect(await poolWith().setViewportLease('s-unknown', MOBILE)).toBe(false);
  });
});
