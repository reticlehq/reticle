/**
 * Whether a page on a REAL Chromium is still loading, as replay asks it past the step budget
 * (#2155).
 *
 * The unit tests prove the rule with a fake clock and fake requests. This test proves the parts
 * they cannot see:
 *
 * - The Playwright request events reach the tracker on the page that `reticle verify` drives
 *   (`LaunchedRealInputProvider`) and on a pool lease (`playwrightLauncher`). A dynamic `import()`
 *   is a request that stays open while the dev server holds it, and the document is `complete`.
 * - An app that awaits its data before it imports the next module has only that data request open.
 * - A page that runs an endless loop never answers `page.evaluate`. Replay must still end its wait,
 *   and say that the page did not answer.
 *
 * The server holds each response until the test releases it, so the test asserts states, not
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
import { navigateAndAwait } from '../server/dist/language/flows/flow-start-path.js';

/** The path of the module that the dev server holds. */
const HELD_MODULE_PATH = '/held-module.js';
/** The path of the data that the app awaits before it imports the next module. */
const HELD_DATA_PATH = '/held-data';
/** A page that spins forever after it loads. */
const FROZEN_PATH = '/frozen';
/** The request a frozen page sends just before it spins. */
const SPINNING_PATH = '/spinning';
/** The query parameter that names which test the held request belongs to. */
const HOLD_PARAM = 'hold';
/** The query parameter that says the page awaits its data before the import. */
const DATA_FIRST_PARAM = 'data-first';
/** How long a poll may take. Generous: a loaded runner is slow, and the poll ends on the state. */
const POLL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 50;
const TEST_TIMEOUT_MS = 60_000;
/**
 * Past the quiet time after the last request (`REQUEST_QUIET_MS`, 1 s), so that only the held
 * request can say the page is loading. A wait, not an assertion about a duration.
 */
const PAST_QUIET_MS = 2_000;

/** The hold of a request that the server answers at once. */
const NO_HOLD = 'none';

/**
 * A page that is `complete` at once and then imports one module that the server holds. With
 * `dataFirst`, it first awaits data that the server holds, and the module then comes at once.
 */
function pageFor(hold: string, dataFirst: boolean): string {
  const moduleHold = dataFirst ? NO_HOLD : hold;
  const moduleSrc = JSON.stringify(`${HELD_MODULE_PATH}?${HOLD_PARAM}=${moduleHold}`);
  const dataSrc = JSON.stringify(`${HELD_DATA_PATH}?${HOLD_PARAM}=${hold}`);
  const load = dataFirst
    ? `const data = await fetch(${dataSrc}); await data.text(); await import(${moduleSrc});`
    : `import(${moduleSrc});`;
  return `<!doctype html><title>held</title><body><script type="module">${load}</script></body>`;
}

/** The page that spins after it loads. The beacon tells the test that the spin is about to start. */
const FROZEN_PAGE = `<!doctype html><title>frozen</title><body><script>
addEventListener('load', () => setTimeout(() => {
  navigator.sendBeacon(${JSON.stringify(SPINNING_PATH)});
  for (;;) {}
}, 100));
</script></body>`;

/** The held responses, by test, and the requests that arrived. */
const held = new Map<string, http.ServerResponse>();
const arrived = new Set<string>();
let spinning = false;

function release(hold: string): void {
  const res = held.get(hold);
  held.delete(hold);
  res?.writeHead(200, { 'content-type': 'text/javascript' });
  res?.end('globalThis.heldLoaded = true;');
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const hold = url.searchParams.get(HOLD_PARAM) ?? '';
    if (url.pathname === HELD_MODULE_PATH || url.pathname === HELD_DATA_PATH) {
      arrived.add(`${url.pathname}:${hold}`);
      held.set(hold, res);
      if (NO_HOLD === hold) {
        release(hold);
      }
      return;
    }
    if (url.pathname === SPINNING_PATH) {
      spinning = true;
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (url.pathname === FROZEN_PATH) {
      res.end(FROZEN_PAGE);
      return;
    }
    res.end(pageFor(hold, url.searchParams.has(DATA_FIRST_PARAM)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
});

afterAll(async () => {
  for (const hold of [...held.keys()]) {
    release(hold);
  }
  server.closeAllConnections();
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
          newPage: async (pageOpts) => {
            const page = await context.newPage(pageOpts);
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
 * The shared check. While the server holds the request, the document is `complete` and the page
 * still counts as loading. After the release and the quiet time, it counts as loaded.
 */
async function expectLoadingUntilRelease(
  request: string,
  hold: string,
  readyState: () => Promise<unknown>,
  loading: () => Promise<boolean>,
): Promise<void> {
  await expect.poll(() => arrived.has(`${request}:${hold}`), poll).toBe(true);
  // `readyState` alone says loaded. This is the state that made replay stop at the budget.
  await expect.poll(readyState, poll).toBe('complete');
  await new Promise((resolve) => setTimeout(resolve, PAST_QUIET_MS));
  expect(await loading()).toBe(true);

  release(hold);
  await expect.poll(loading, poll).toBe(false);
}

/** A driven provider on `path`, with the pages it opened. Disposed by the caller. */
function drivenOn(path: string): { provider: LaunchedRealInputProvider; pages: Page[] } {
  const pages: Page[] = [];
  const provider = new LaunchedRealInputProvider({
    driveUrl: `${baseUrl}${path}`,
    headless: true,
    launch: recordingChromium(pages),
  });
  return { provider, pages };
}

describe('a page whose dev server holds what it loads (#2155)', () => {
  it(
    'counts as loading on the page that verify drives, until the module arrives',
    async () => {
      const hold = 'driven';
      const { provider, pages } = drivenOn(`?${HOLD_PARAM}=${hold}`);
      try {
        await provider.navigate();
        await expectLoadingUntilRelease(
          HELD_MODULE_PATH,
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
    'counts as loading while the app awaits its data before it imports the next module',
    async () => {
      const hold = 'data-first';
      const { provider, pages } = drivenOn(`?${HOLD_PARAM}=${hold}&${DATA_FIRST_PARAM}`);
      try {
        await provider.navigate();
        await expectLoadingUntilRelease(
          HELD_DATA_PATH,
          hold,
          () => pages[0]?.evaluate('document.readyState') ?? Promise.resolve(undefined),
          () => provider.drivenPageLoading(),
        );
      } finally {
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
          HELD_MODULE_PATH,
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

describe('a page that runs an endless loop after it loads (#2155)', () => {
  it(
    'does not hold replay: its wait ends, and says that the page did not answer',
    async () => {
      const { provider } = drivenOn(FROZEN_PATH.slice(1));
      try {
        await provider.navigate();
        await expect.poll(() => spinning, poll).toBe(true);
        // The tab never reconnects: the session stays the one that asked for the navigation.
        const tab = {
          id: 'frozen',
          url: `${baseUrl}${FROZEN_PATH.slice(1)}`,
          eventsSince: () => [],
          command: () =>
            Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: { ok: true } }),
        };
        const sessions = { resolve: () => tab };
        // A budget past the quiet time of the last request, so the page itself is asked.
        const outcome = await navigateAndAwait(
          sessions as never,
          tab as never,
          `${baseUrl}elsewhere`,
          '/elsewhere',
          2_000,
          undefined,
          { stillLoading: () => provider.drivenPageLoading(), loadingCapMs: 4_000 },
        );
        expect(outcome.kind).toBe('lost');
        expect('lost' === outcome.kind && outcome.unanswered).toBe(true);
      } finally {
        await provider.dispose();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
