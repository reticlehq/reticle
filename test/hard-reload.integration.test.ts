/**
 * A hard reload of a leased page runs the module as it is now, not the cached copy (#1785).
 *
 * `reticle_navigate { reload: true, hard: true }` said it bypassed the cache. It only added a query
 * parameter to the page URL, so the document was fetched again and every script and ES module came
 * from the cache. On a dev server that sends no cache headers, an edited module stayed stale.
 *
 * The server here sends a module with a long `max-age`, which a plain reload is allowed to serve
 * from the cache. Only a reload with the cache ignored fetches it again.
 *
 * Heavy + Chromium-dependent, so it lives with the other integration tests (`pnpm test:integration`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:http';
import { BrowserPool, playwrightLauncher } from '@reticlehq/server';

const PAGE = `<!doctype html><title>hard reload</title><body>
<script type="module" src="/version.js"></script>
</body>`;

let server: http.Server;
let baseUrl: string;
let moduleVersion = 'v1';
let moduleRequests = 0;
/** The version each run of the module reported back, in order. */
const ran: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/ran?v=') === true) {
      ran.push(decodeURIComponent(req.url.slice('/ran?v='.length)));
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/version.js') {
      moduleRequests += 1;
      res.writeHead(200, {
        'content-type': 'text/javascript',
        'cache-control': 'public, max-age=3600',
      });
      // The module reports which version of itself ran, so the test reads it from the server.
      res.end(`void fetch('/ran?v=' + encodeURIComponent(${JSON.stringify(moduleVersion)}));`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until the module has run `count` times, or give up after a generous bound. */
async function runs(count: number): Promise<readonly string[]> {
  for (let attempt = 0; attempt < 200 && ran.length < count; attempt += 1) {
    await wait(50);
  }
  return ran;
}

describe('a hard reload of a leased page', () => {
  it('fetches an edited module again instead of running the cached copy', async () => {
    ran.length = 0;
    moduleVersion = 'v1';
    const pool = new BrowserPool(playwrightLauncher({ headless: true }), {
      maxContexts: 1,
      genSessionId: (): string => 'lease-1',
    });
    try {
      const lease = await pool.acquire(baseUrl);
      expect(await runs(1)).toEqual(['v1']);
      const fetchedOnLoad = moduleRequests;

      moduleVersion = 'v2';
      expect(await pool.hardReloadLease(lease.sessionId)).toBe(true);

      expect(await runs(2)).toEqual(['v1', 'v2']);
      expect(moduleRequests).toBeGreaterThan(fetchedOnLoad);
    } finally {
      await pool.shutdown();
    }
  }, 60_000);

  /*
   * The bug, on the same server: what `hard` did before was a navigation to the page URL with a new
   * query parameter. The document is new, so it is fetched, but the module comes from the cache.
   */
  it('a cache-busting query on the page URL still runs the cached module', async () => {
    ran.length = 0;
    moduleVersion = 'v1';
    const pool = new BrowserPool(playwrightLauncher({ headless: true }), {
      maxContexts: 1,
      genSessionId: (): string => 'lease-2',
    });
    try {
      const lease = await pool.acquire(baseUrl);
      expect(await runs(1)).toEqual(['v1']);

      moduleVersion = 'v2';
      expect(await pool.gotoLease(lease.sessionId, `${baseUrl}?_reticle_reload=1`)).toBe(true);

      expect(await runs(2)).toEqual(['v1', 'v1']);
    } finally {
      await pool.shutdown();
    }
  }, 60_000);

  it('answers false for a session that is not a lease', async () => {
    const pool = new BrowserPool(playwrightLauncher({ headless: true }), { maxContexts: 1 });
    try {
      expect(await pool.hardReloadLease('not-a-lease')).toBe(false);
    } finally {
      await pool.shutdown();
    }
  });
});
