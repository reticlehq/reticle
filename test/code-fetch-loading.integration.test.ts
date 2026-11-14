/**
 * A page counts as loading while a REAL Chromium still fetches a module that it imports dynamically
 * (#2155).
 *
 * The unit tests prove the rule with a fake clock and fake requests. This test proves the part they
 * cannot see: the Playwright request events reach the tracker on the page that `reticle verify`
 * drives (`LaunchedRealInputProvider`) and on a pool lease (`playwrightLauncher`). Without that
 * wiring, `document.readyState` is `complete` while the dev server holds the module, and replay
 * read the start page as loaded and stopped at the 5 s step budget.
 *
 * The server holds the module until the test releases it, so the test asserts states, not
 * durations (rule 15). Heavy + Chromium-dependent, so it lives with the other integration tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright';
import {
  BrowserPool,
  LaunchedRealInputProvider,
  playwrightLauncher,
  type Launcher,
} from '@reticlehq/server';

/** The path of the module that the dev server holds. */
const HELD_MODULE_PATH = '/held-module.js';
/** The query parameter that names which test the held request belongs to. */
const HOLD_PARAM = 'hold';
/** How long a poll may take. Generous: a loaded runner is slow, and the poll ends on the state. */
const POLL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 50;
const TEST_TIMEOUT_MS = 60_000;

/** A page that is `complete` at once and then imports one module that the server holds. */
function pageFor(hold: string): string {
  const src = `${HELD_MODULE_PATH}?${HOLD_PARAM}=${hold}`;
  return `<!doctype html><title>held module</title><body>
<script type="module">import(${JSON.stringify(src)});</script>
</body>`;
}

/** The held module responses, by test, and the requests that arrived. */
const held = new Map<string, http.ServerResponse>();
const arrived = new Set<string>();

function release(hold: string): void {
  const res = held.get(hold);
  held.delete(hold);
  res?.writeHead(200, { 'content-type': 'text/javascript' });
  res?.end('globalThis.heldModuleLoaded = true;');
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const hold = url.searchParams.get(HOLD_PARAM) ?? '';
    if (url.pathname === HELD_MODULE_PATH) {
      arrived.add(hold);
      held.set(hold, res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(pageFor(hold));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
});

afterAll(async () => {
  for (const hold of [...held.keys()]) {
    release(hold);
  }
  await new Promise<void>((r) => server.close(() => r()));
});

type PooledPage = Awaited<
  ReturnType<Awaited<ReturnType<Awaited<ReturnType<Launcher>>['newContext']>>['newPage']>
>;

/** The pool's real launcher, which keeps the pages it opens so the test can read them. */
function recordingLauncher(pages: PooledPage[]): Launcher {
  const real = playwrightLauncher({ headless: true });
  return async () => {
    const browser = await real();
    return {
      ...browser,
      isConnected: () => browser.isConnected(),
      close: () => browser.close(),
      onDisconnected: (handler) => browser.onDisconnected(handler),
      newContext: async (opts) => {
        const context = await browser.newContext(opts);
        return {
          ...context,
          close: () => context.close(),
          newPage: async () => {
            const page = await context.newPage();
            pages.push(page);
            return page;
          },
        };
      },
    };
  };
}

/** A real headless Chromium for the driven provider, which keeps the pages it opens. */
function recordingChromium(pages: Page[]): () => ReturnType<typeof chromium.launch> {
  return async () => {
    const browser = await chromium.launch({ headless: true });
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (opts) => {
      const page = await newPage(opts);
      pages.push(page);
      return page;
    };
    return browser;
  };
}

const poll = { timeout: POLL_TIMEOUT_MS, interval: POLL_INTERVAL_MS };

/**
 * The shared check. While the server holds the module, the document is `complete` and the page
 * still counts as loading. After the release and the quiet time, it counts as loaded.
 */
async function expectLoadingUntilRelease(
  hold: string,
  readyState: () => Promise<unknown>,
  loading: () => Promise<boolean>,
): Promise<void> {
  await expect.poll(() => arrived.has(hold), poll).toBe(true);
  // `readyState` alone says loaded. This is the state that made replay stop at the budget.
  await expect.poll(readyState, poll).toBe('complete');
  expect(await loading()).toBe(true);

  release(hold);
  await expect.poll(loading, poll).toBe(false);
}

describe('a page whose dynamically imported module the dev server holds (#2155)', () => {
  it(
    'counts as loading on the page that verify drives, until the module arrives',
    async () => {
      const hold = 'driven';
      const pages: Page[] = [];
      const provider = new LaunchedRealInputProvider({
        driveUrl: `${baseUrl}?${HOLD_PARAM}=${hold}`,
        headless: true,
        launch: recordingChromium(pages),
      });
      try {
        await provider.navigate();
        await expectLoadingUntilRelease(
          hold,
          () => pages[0]?.evaluate('document.readyState') ?? Promise.resolve(undefined),
          () => provider.drivenPageLoading(),
        );
      } finally {
        // A failed check leaves the module held, and an open request can hold the close.
        release(hold);
        await provider.dispose();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'counts as loading on a pool lease, until the module arrives',
    async () => {
      const hold = 'lease';
      const pages: PooledPage[] = [];
      const pool = new BrowserPool(recordingLauncher(pages), {
        maxContexts: 1,
        genSessionId: () => 'lease-1',
      });
      try {
        const lease = await pool.acquire(`${baseUrl}?${HOLD_PARAM}=${hold}`);
        await expectLoadingUntilRelease(
          hold,
          () => pages[0]?.evaluate?.('document.readyState') ?? Promise.resolve(undefined),
          () => pool.leaseLoading(lease.sessionId),
        );
      } finally {
        release(hold);
        await pool.shutdown();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
