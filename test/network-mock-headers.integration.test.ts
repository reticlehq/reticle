/**
 * A mocked response carries the headers that the app reads, on a real Chromium (#1845).
 *
 * `reticle_network_mock` took only `status` and `body`. So an app that reads `Retry-After`,
 * `Content-Disposition` or a custom header could not be tested against a mocked response. These
 * mock a lease's request and read the response with `fetch`, the way the app does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserPool, playwrightLauncher, type Launcher } from '@reticlehq/server';

type PooledPage = Awaited<
  ReturnType<Awaited<ReturnType<Awaited<ReturnType<Launcher>>['newContext']>>['newPage']>
>;

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

/** What the app reads from the response of `/api/export`. */
const READ_EXPORT = `fetch('/api/export').then(async (r) => ({
  status: r.status,
  retryAfter: r.headers.get('retry-after'),
  requestId: r.headers.get('x-request-id'),
  contentType: r.headers.get('content-type'),
  body: await r.text(),
}))`;

let server: http.Server;
let url: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/export')) {
      // The real endpoint sends none of the headers that the mocks set.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"real":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>export</title><body>export</body>');
  });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${String((server.address() as AddressInfo).port)}/`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('a mocked response carries headers on a real page', () => {
  it('lets the app read a mocked Retry-After and a custom header', async () => {
    const pages: PooledPage[] = [];
    const pool = new BrowserPool(recordingLauncher(pages), {
      maxContexts: 1,
      genSessionId: () => 'headers',
    });
    try {
      const lease = await pool.acquire(url);
      const read = async (): Promise<unknown> => pages[0]?.evaluate?.(READ_EXPORT);

      expect(await read()).toMatchObject({ status: 200, retryAfter: null, requestId: null });

      const applied = await pool.setMocksLease(lease.sessionId, [
        {
          urlContains: '/api/export',
          status: 429,
          body: '{"error":"slow down"}',
          headers: { 'Retry-After': '30', 'X-Request-Id': 'abc' },
        },
      ]);
      expect(applied).toBe(true);
      expect(await read()).toEqual({
        status: 429,
        retryAfter: '30',
        requestId: 'abc',
        contentType: 'application/json',
        body: '{"error":"slow down"}',
      });
    } finally {
      await pool.shutdown();
    }
  });

  it('keeps a Content-Type that the rule sets in headers', async () => {
    const pages: PooledPage[] = [];
    const pool = new BrowserPool(recordingLauncher(pages), {
      maxContexts: 1,
      genSessionId: () => 'csv',
    });
    try {
      const lease = await pool.acquire(url);
      await pool.setMocksLease(lease.sessionId, [
        { urlContains: '/api/export', body: 'a,b', headers: { 'Content-Type': 'text/csv' } },
      ]);
      expect(await pages[0]?.evaluate?.(READ_EXPORT)).toMatchObject({
        contentType: 'text/csv',
        body: 'a,b',
      });
    } finally {
      await pool.shutdown();
    }
  });

  /*
   * A Content-Length that does not match the body is not refused. Chromium fulfills the response
   * with the full body, so the request does not wait. If it waits, this test times out.
   */
  it('fulfills a rule whose Content-Length does not match the body', async () => {
    const pages: PooledPage[] = [];
    const pool = new BrowserPool(recordingLauncher(pages), {
      maxContexts: 1,
      genSessionId: () => 'length',
    });
    try {
      const lease = await pool.acquire(url);
      await pool.setMocksLease(lease.sessionId, [
        { urlContains: '/api/export', body: 'ab', headers: { 'Content-Length': '99' } },
      ]);
      expect(await pages[0]?.evaluate?.(READ_EXPORT)).toMatchObject({ status: 200, body: 'ab' });
    } finally {
      await pool.shutdown();
    }
  });
});
