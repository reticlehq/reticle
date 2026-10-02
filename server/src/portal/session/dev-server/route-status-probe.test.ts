/**
 * The out-of-band route fetch behind the ROUTE_SERVER_ERROR diagnosis (#808, option 3).
 *
 * Driven against a real local server rather than a stubbed request, because the guards this file
 * exists for — loopback only, http only, never the body — are about what leaves the socket, and a
 * stub cannot show that.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { probeRouteStatus } from './route-status-probe.js';

let server: Server | undefined;
let seenPath: string | undefined;
let seenMethod: string | undefined;

function serve(status: number, body = 'x'.repeat(4096)): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      seenPath = req.url;
      seenMethod = req.method;
      res.statusCode = status;
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      const port = 'object' === typeof address && address !== null ? address.port : 0;
      resolve(`http://127.0.0.1:${String(port)}`);
    });
  });
}

afterEach(async () => {
  const s = server;
  server = undefined;
  seenPath = undefined;
  seenMethod = undefined;
  if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe('probeRouteStatus', () => {
  it('reports the status a local route answers, for the exact path asked', async () => {
    const origin = await serve(500);
    const status = await probeRouteStatus(`${origin}/orders/explode?tab=1`);
    expect(status).toBe(500);
    // The exact path, query included — a probe of `/` would say nothing about the route that died.
    expect(seenPath).toBe('/orders/explode?tab=1');
    expect(seenMethod).toBe('GET');
  });

  it('reports a healthy answer as its status too, so the caller decides what it means', async () => {
    const origin = await serve(200);
    expect(await probeRouteStatus(`${origin}/`)).toBe(200);
  });

  it('never leaves loopback — a non-local hostname is not fetched', async () => {
    // The daemon is localhost-only. A diagnostic that reaches out to an arbitrary host on a
    // remembered URL is a posture change, and no status is worth it.
    expect(await probeRouteStatus('http://example.com/orders')).toBeUndefined();
    expect(await probeRouteStatus('http://10.0.0.5:3000/orders')).toBeUndefined();
  });

  it('skips https rather than fetching with verification off', async () => {
    expect(await probeRouteStatus('https://localhost:3000/orders')).toBeUndefined();
  });

  it('answers undefined, never a status, for a URL it cannot parse', async () => {
    expect(await probeRouteStatus('not a url')).toBeUndefined();
  });

  it('answers undefined when nothing is listening — no fact, not a wrong one', async () => {
    // Bind then close, so the port is known free.
    const origin = await serve(200);
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s?.close(() => resolve()));
    expect(await probeRouteStatus(`${origin}/orders`)).toBeUndefined();
  });

  it('gives up on a server that accepts and never answers, inside the budget', async () => {
    await new Promise<void>((resolve) => {
      server = createServer(() => {
        /* accept, and never respond */
      });
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server?.address();
    const port = 'object' === typeof address && address !== null ? address.port : 0;
    // A tight injected budget; the property is that it RETURNS, not how long it took.
    expect(await probeRouteStatus(`http://127.0.0.1:${String(port)}/slow`, 100)).toBeUndefined();
  }, 5_000);
});
