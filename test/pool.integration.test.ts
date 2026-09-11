/**
 * BrowserPool — REAL headless Chromium integration tests (consolidated from plan/stress).
 *
 * These drive the actual Playwright launcher (not a fake), so they prove the properties the
 * multi-agent design depends on against a real browser: one shared Chromium hands out N capped
 * isolated contexts, an over-cap burst is genuinely blocked, orphaned leases are reclaimed, and
 * heavy churn leaks nothing. Heavy + Chromium-dependent, so they live here (run via `pnpm
 * test:integration`), NOT in the fast per-package unit gate.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page as PlaywrightPage } from 'playwright';
import { BrowserPool, playwrightLauncher, type Launcher } from '@reticlehq/server';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function counter(): () => string {
  let n = 0;
  return () => `s${String(++n)}`;
}
/** A launcher that records how many real browsers it actually started. */
function countingLauncher(): { launch: Launcher; count: () => number } {
  let launches = 0;
  const inner = playwrightLauncher({ headless: true });
  return {
    launch: () => {
      launches += 1;
      return inner();
    },
    count: () => launches,
  };
}

let server: http.Server;
let url: string;

beforeAll(async () => {
  // A trivial page — the pool's job is context lifecycle, not the SDK.
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>x</title><body><button>b</button></body>');
  });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${String((server.address() as AddressInfo).port)}/`;
});

afterAll(() => {
  server.close();
});

describe('BrowserPool — real Chromium', () => {
  it('serves N capped isolated contexts from ONE browser under concurrent load', async () => {
    const { launch, count } = countingLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 3, genSessionId: counter() });
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, pool.activeCount());
    }, 5);

    // 8 "agents" each lease, hold a beat (a flow), then release — exercising the cap.
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const lease = await pool.acquire(url);
        await sleep(60);
        await lease.release();
      }),
    );
    clearInterval(sampler);

    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(3); // the cap held under real concurrency
    expect(count()).toBe(1); // ONE browser served all 8
    expect(pool.activeCount()).toBe(0); // no leaked contexts
    await pool.shutdown();
  });

  it('blocks an over-cap burst — exactly cap leases resolve, the rest queue', async () => {
    const { launch } = countingLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counter() });

    const acquires = Array.from({ length: 6 }, () => pool.acquire(url));
    let resolved = 0;
    acquires.forEach((p) => void p.then(() => (resolved += 1)));
    const start = Date.now();
    while (resolved < 2 && Date.now() - start < 3000) {
      await sleep(50);
    }
    await sleep(200);

    expect(resolved).toBe(2); // only the cap
    expect(pool.activeCount()).toBe(2);
    expect(pool.queuedCount()).toBe(4); // the rest are blocked, not over-provisioned

    // Drain release-on-resolve so the queue cascades and nothing dangles.
    await Promise.all(
      acquires.map(async (p) => {
        const lease = await p;
        await lease.release();
      }),
    );
    expect(pool.activeCount()).toBe(0);
    expect(pool.queuedCount()).toBe(0);
    await pool.shutdown();
  });

  it('reclaims an orphaned (untouched) lease after its TTL; a touched one survives', async () => {
    const { launch } = countingLauncher();
    let clock = 1000;
    const pool = new BrowserPool(launch, {
      maxContexts: 4,
      genSessionId: counter(),
      now: () => clock,
      leaseTtlMs: 500,
    });

    const stale = await pool.acquire(url);
    const fresh = await pool.acquire(url);
    clock += 600; // both past the TTL in wall terms…
    pool.touch(fresh.sessionId); // …but fresh was just touched

    const reclaimed = await pool.sweepExpired();
    expect(reclaimed).toEqual([stale.sessionId]);
    expect(pool.activeCount()).toBe(1);
    expect(pool.leasedSessionIds()).toEqual([fresh.sessionId]);
    await pool.shutdown();
  });

  it('churns 40 acquire/release cycles with no leak and one reused browser', async () => {
    const { launch, count } = countingLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 3, genSessionId: counter() });

    await Promise.all(
      Array.from({ length: 40 }, async () => {
        const lease = await pool.acquire(url);
        await sleep(5);
        await lease.release();
      }),
    );

    expect(pool.activeCount()).toBe(0);
    expect(pool.queuedCount()).toBe(0);
    expect(count()).toBeLessThanOrEqual(2); // browser reused across all 40
    await pool.shutdown();
  }, 15000);

  it('seeds storage on initial navigation and proves one-time semantics on real Chromium reload', async () => {
    let capturedPage: PlaywrightPage | undefined;
    const launch: Launcher = async () => {
      const browser = await chromium.launch({ headless: true });
      return {
        isConnected: () => browser.isConnected(),
        close: () => browser.close(),
        onDisconnected: (h) => browser.on('disconnected', h),
        newContext: async () => {
          const ctx = await browser.newContext();
          return {
            addCookies: (cookies) => ctx.addCookies(cookies),
            close: () => ctx.close(),
            newPage: async () => {
              const p = await ctx.newPage();
              capturedPage = p;
              return {
                goto: (u) => p.goto(u, { waitUntil: 'domcontentloaded' }),
                close: () => p.close(),
                onCrash: (h) => p.on('crash', h),
                onConsole: (h) => p.on('console', (msg) => h(msg.text())),
                addInitScript: async (script, arg) => {
                  const handle = await p.addInitScript(script as never, arg);
                  return { dispose: () => handle.dispose() };
                },
              };
            },
          };
        },
      };
    };

    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counter() });

    const seedStorage = {
      local: { auth_token: 'real-jwt-token-123' },
      session: { tab_state: 'active-tab-99' },
      cookies: { session_cookie: 'cookie-abc-456' },
    };

    // 1. Initial navigation seeds storage before application code runs
    const lease = await pool.acquire(url, { seedStorage });
    expect(capturedPage).toBeDefined();

    const initialLocal = await capturedPage!.evaluate(() => localStorage.getItem('auth_token'));
    const initialSession = await capturedPage!.evaluate(() => sessionStorage.getItem('tab_state'));
    const initialCookies = await capturedPage!.context().cookies();

    expect(initialLocal).toBe('real-jwt-token-123');
    expect(initialSession).toBe('active-tab-99');
    expect(
      initialCookies.some((c) => c.name === 'session_cookie' && c.value === 'cookie-abc-456'),
    ).toBe(true);

    // 2. Application logs out and clears storage
    await capturedPage!.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    expect(await capturedPage!.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();
    expect(await capturedPage!.evaluate(() => sessionStorage.getItem('tab_state'))).toBeNull();

    // 3. Real Chromium reload: init script was disposed, so the old seed MUST NOT be restored
    await capturedPage!.reload();

    const postReloadLocal = await capturedPage!.evaluate(() => localStorage.getItem('auth_token'));
    const postReloadSession = await capturedPage!.evaluate(() =>
      sessionStorage.getItem('tab_state'),
    );

    expect(postReloadLocal).toBeNull();
    expect(postReloadSession).toBeNull();

    // 4. Release cleans up context
    await lease.release();
    expect(pool.activeCount()).toBe(0);
    await pool.shutdown();
  });

  it('detects real storage write failure, rejects acquire, cleans up context and releases slot', async () => {
    const pool = new BrowserPool(playwrightLauncher({ headless: true }), {
      maxContexts: 2,
      genSessionId: counter(),
    });

    // In real Chromium, navigating to a data: URL results in an opaque origin (origin === 'null').
    // In Chromium, attempting to access or write localStorage in an opaque origin throws a real SecurityError.
    const failingDataUrl = 'data:text/html,<!doctype html><title>Opaque</title>';
    const secretValue = 'super-sensitive-secret-value-999';

    let errorThrown: Error | undefined;
    try {
      await pool.acquire(failingDataUrl, {
        seedStorage: { local: { secret_token: secretValue } },
      });
    } catch (err) {
      errorThrown = err as Error;
    }

    // 1. Browser-side failure was detected in Node
    expect(errorThrown).toBeDefined();
    expect(errorThrown!.message).toMatch(
      /Storage seeding failed: localStorage write failed: SecurityError/,
    );

    // 2. Secret value is NEVER leaked in the error
    expect(errorThrown!.message).not.toContain(secretValue);

    // 3. Pool context was cleaned up and slot released
    expect(pool.activeCount()).toBe(0);
    expect(pool.queuedCount()).toBe(0);

    await pool.shutdown();
  });
});
