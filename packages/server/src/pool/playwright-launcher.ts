/**
 * The real Playwright adapter behind BrowserPool: wraps `chromium.launch` into the pool's small
 * PooledBrowser/Context/Page interfaces. Kept thin and separate so the pool's lifecycle logic stays
 * unit-tested with a fake while this glue is exercised only by the e2e battery (it needs Chromium).
 *
 * Headless by default — the pool exists for fault-tolerant headless multi-agent testing.
 */

import { chromium, type Browser } from 'playwright';
import type { Launcher, PooledBrowser, PooledContext, PooledPage } from './browser-pool.js';

function wrapBrowser(browser: Browser): PooledBrowser {
  return {
    isConnected: () => browser.isConnected(),
    newContext: async (): Promise<PooledContext> => {
      const context = await browser.newContext();
      return {
        newPage: async (): Promise<PooledPage> => {
          const page = await context.newPage();
          return {
            goto: (url, opts) =>
              page.goto(
                url,
                opts?.timeoutMs === undefined ? undefined : { timeout: opts.timeoutMs },
              ),
            close: () => page.close(),
            onCrash: (handler) => page.on('crash', handler),
          };
        },
        close: () => context.close(),
      };
    },
    close: () => browser.close(),
    onDisconnected: (handler) => browser.on('disconnected', handler),
  };
}

/** A Launcher that boots a real headless Chromium and adapts it to the pool's interface. */
export function playwrightLauncher(opts: { headless?: boolean } = {}): Launcher {
  const headless = opts.headless ?? true;
  return async () => wrapBrowser(await chromium.launch({ headless }));
}

const MAX_CONTEXTS_CEILING = 8;
const MAX_CONTEXTS_FLOOR = 1;
/**
 * Hard backstop for an EXPLICIT RETICLE_MAX_CONTEXTS. The operator override still wins for any
 * realistic value (well above the CPU-derived ceiling), but a typo/abuse like 5000 can't spawn 5000
 * browser contexts and exhaust memory/FDs — the fork-bomb the function's own comment warns about.
 */
const MAX_CONTEXTS_HARD_CEILING = 128;

/**
 * Resolve the pool's concurrency cap. An explicit RETICLE_MAX_CONTEXTS wins (clamped to
 * [1, hard ceiling]); otherwise scale with the machine but never above the CPU-derived ceiling.
 * Pure (env value + cpu count passed in) so it's testable.
 */
export function resolveMaxContexts(envValue: string | undefined, cpuCount: number): number {
  if (envValue !== undefined) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed >= MAX_CONTEXTS_FLOOR) {
      return Math.min(MAX_CONTEXTS_HARD_CEILING, parsed);
    }
  }
  const byCpu = Math.max(MAX_CONTEXTS_FLOOR, cpuCount - 1);
  return Math.min(MAX_CONTEXTS_CEILING, byCpu);
}
