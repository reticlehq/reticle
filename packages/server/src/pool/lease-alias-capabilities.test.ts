/**
 * Every agent-facing lease capability must accept the id the agent was actually given.
 *
 * A leased page runs the SDK, which dials and registers under its OWN session id, so the id
 * `reticle_sessions` shows an agent is routinely the ALIAS rather than the lease key. `#leaseIdOf`
 * exists to bridge that, and four capabilities did not use it — screenshots, hover, network mocks
 * and the dial-failure diagnostic. Each refused for a lease that was alive and working, addressed by
 * the only id its caller had.
 *
 * `reticle_network_mock` is where it surfaced. A reporter got `applied: false, reason:
 * "no-cdp-provider"` in EVERY configuration they could reach — always-on session, acquired lease,
 * after installing Chromium, after restarting the daemon, and after `npx @reticlehq/server drive`
 * — and the recommendation it printed ("start with `reticle drive <url>`") could not fix it, because
 * the provider was never the problem. Their conclusion: error-path verification is impossible
 * without shipping failure-injection code inside the application, which is exactly what an external
 * mock exists to avoid.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledPage } from './browser-pool.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A launcher whose page records what was driven on it. */
const launcher = (page: Partial<Record<keyof PooledPage, unknown>> = {}): Launcher => {
  const full = {
    goto: () => Promise.resolve(),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
    screenshot: () => Promise.resolve(PNG),
    hover: () => Promise.resolve(),
    installMocks: () => Promise.resolve(),
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

/** The id the SDK inside the leased page registers itself under — what the agent is handed. */
const REGISTERED = 's-registered-by-the-sdk';

let pool: BrowserPool;
let leaseId: string;
let installMocks: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  installMocks = vi.fn(() => Promise.resolve());
  pool = new BrowserPool(launcher({ installMocks }), { maxContexts: 2, genSessionId: ids });
  const lease = await pool.acquire('http://app.test/');
  leaseId = lease.sessionId;
  pool.alias(REGISTERED, leaseId);
});

describe('a capability addressed by the lease key works', () => {
  it('applies network mocks', async () => {
    expect(await pool.setMocksLease(leaseId, [])).toBe(true);
  });
});

describe('the same capability addressed by the SDK registered id also works', () => {
  it('applies network mocks — the reported failure', async () => {
    expect(
      await pool.setMocksLease(REGISTERED, [{ urlContains: '/api/pay', status: 500 }]),
      'the agent only ever saw the registered id; refusing it made the mock unreachable',
    ).toBe(true);
    expect(installMocks).toHaveBeenCalled();
  });

  it('takes a screenshot', async () => {
    expect(await pool.screenshotLease(REGISTERED)).toBeDefined();
  });

  it('hovers', async () => {
    expect(await pool.hoverLease(REGISTERED, 1, 1)).toBe(true);
  });
});

describe('an id that is neither a lease nor an alias is still refused', () => {
  it.each([
    ['network mocks', (): Promise<boolean> => pool.setMocksLease('s-unknown', [])],
    ['hover', (): Promise<boolean> => pool.hoverLease('s-unknown', 1, 1)],
  ])('refuses %s for an unknown session', async (_label, call) => {
    expect(await call(), 'resolving aliases must not turn into resolving anything').toBe(false);
  });

  it('returns no screenshot for an unknown session', async () => {
    expect(await pool.screenshotLease('s-unknown')).toBeUndefined();
  });
});
