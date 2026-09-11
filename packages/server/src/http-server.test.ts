import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DRIVE_PATH, MCP_SHUTDOWN_EVENT, MCP_SSE_PATH, STATUS_PATH } from '@reticlehq/core';
import { createSharedServer, type SharedServer } from './http-server.js';

let shared: SharedServer | undefined;

afterEach(async () => {
  await shared?.close();
  shared = undefined;
});

function listen(server: SharedServer): Promise<number> {
  return new Promise((resolve) => {
    server.httpServer.listen(0, '127.0.0.1', () => {
      const addr = server.httpServer.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

function get(
  port: number,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('GET /status', () => {
  it('returns the attached status provider payload as JSON', async () => {
    shared = createSharedServer();
    shared.attachStatus(() => ({
      running: true,
      sessionCount: 1,
      sessions: [{ sessionId: 'demo', url: 'http://localhost:5173', throttled: false }],
    }));
    const port = await listen(shared);
    const res = await get(port, STATUS_PATH);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { sessionCount: number; sessions: unknown[] };
    expect(parsed.sessionCount).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
  });

  it('falls back to a minimal running body when no status provider is attached', async () => {
    shared = createSharedServer();
    const port = await listen(shared);
    const res = await get(port, STATUS_PATH);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ running: true });
  });

  it('still serves a loopback peer with no token even when a token IS configured (local trust)', async () => {
    // The token gate must never break the local stdio proxy / `reticle status`, which always dial 127.0.0.1.
    shared = createSharedServer({ token: 'a-secret-pairing-token' });
    const port = await listen(shared);
    const res = await get(port, STATUS_PATH);
    expect(res.status).toBe(200);
  });

  it('rejects a DNS-rebound request whose Host header is not loopback (no token configured)', async () => {
    // Rebinding: the page resolves evil.com -> 127.0.0.1 so the peer is loopback, but the browser
    // still sends the attacker Host. Loopback-peer trust must not short-circuit past that.
    shared = createSharedServer();
    const port = await listen(shared);
    const res = await get(port, STATUS_PATH, { host: 'evil.com' });
    expect(res.status).toBe(401);
  });

  it('rejects a request carrying a non-loopback Origin even from a loopback peer', async () => {
    shared = createSharedServer();
    const port = await listen(shared);
    const res = await get(port, STATUS_PATH, { origin: 'http://evil.com' });
    expect(res.status).toBe(401);
  });

  it('serves a loopback peer that sends a loopback Origin (a legit same-daemon page)', async () => {
    shared = createSharedServer();
    const port = await listen(shared);
    const res = await get(port, STATUS_PATH, { origin: `http://localhost:${String(port)}` });
    expect(res.status).toBe(200);
  });
});

/**
 * A no-op McpServer good enough to drive the SSE presence path. connect starts the transport so the
 * SSE response headers flush (the client GET resolves); close is a noop.
 */
function fakeMcpServer(): McpServer {
  return {
    connect: (transport: { start: () => Promise<void> }) => transport.start(),
    close: () => Promise.resolve(),
  } as unknown as McpServer;
}

/**
 * Open an SSE MCP connection and resolve once the response headers arrive. `agent: false` gives each
 * connection its own socket — SSE responses are long-lived, so pooling would serialize them.
 */
function openSse(port: number): Promise<http.ClientRequest> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: MCP_SSE_PATH, agent: false }, () =>
      resolve(req),
    );
    req.on('error', () => undefined); // destroy surfaces as ECONNRESET — expected, ignore
  });
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('attachAgentPresence — agent-independent MCP connection presence', () => {
  it('fires true when the first agent connects and false when the last disconnects', async () => {
    shared = createSharedServer();
    shared.attachMcp(fakeMcpServer);
    const events: boolean[] = [];
    shared.attachAgentPresence((connected) => events.push(connected));
    const port = await listen(shared);

    const req = await openSse(port);
    await tick();
    expect(events).toEqual([true]);

    req.destroy();
    await tick();
    await tick();
    expect(events).toEqual([true, false]);
  });

  it('fires true only once for a second concurrent agent, false only when the last leaves', async () => {
    shared = createSharedServer();
    shared.attachMcp(fakeMcpServer);
    const events: boolean[] = [];
    shared.attachAgentPresence((connected) => events.push(connected));
    const port = await listen(shared);

    const a = await openSse(port);
    const b = await openSse(port);
    await tick();
    expect(events).toEqual([true]); // second agent does not re-fire true

    a.destroy();
    await tick();
    await tick();
    expect(events).toEqual([true]); // one agent still attached — no false yet

    b.destroy();
    await tick();
    await tick();
    expect(events).toEqual([true, false]); // last agent gone → human's turn
  });
});

/**
 * `reticle drive` asks the daemon that already owns the port for a driveable session instead of
 * competing with it for the bind — see cli/drive-attach.ts. This is the daemon's half of that.
 */
describe('POST /drive', () => {
  function post(
    port: number,
    path: string,
    body: string,
    headers: http.OutgoingHttpHeaders = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
        },
        (res) => {
          let received = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (received += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: received }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  /**
   * The daemon opens whatever this route is handed, in a browser it owns, so the scheme is part of
   * the request that has to be checked rather than part of the payload that gets passed through.
   *
   * The CORS defence above already keeps a WEB page off this route — a JSON content type forces a
   * preflight nobody opts into — so the caller here is a local process, which is a much weaker
   * threat. That is the reason this is a refusal and not an alarm. But `file:` reads the disk
   * through a browser context we opened, `data:` is a page we did not fetch from anywhere, and
   * `javascript:` is not a document at all. None of them is a thing `reticle drive` exists to do:
   * it drives a running web app, and nothing in the product passes it anything but http(s).
   */
  it('refuses a scheme that is not http(s), naming what it got', async () => {
    shared = createSharedServer();
    const seen: string[] = [];
    shared.attachDrive((url) => {
      seen.push(url);
      return Promise.resolve({ sessionId: 's1', ready: true });
    });
    const port = await listen(shared);

    for (const url of [
      'file:///etc/hosts',
      'data:text/html,<h1>hi</h1>',
      'javascript:void(0)',
      'ftp://example.com/x',
    ]) {
      const res = await post(port, DRIVE_PATH, JSON.stringify({ url }));
      expect(res.status, url).toBe(400);
      expect(res.body.toLowerCase(), 'the answer names the scheme it refused').toContain('scheme');
    }
    expect(seen, 'nothing reached the browser').toEqual([]);
  });

  it('still accepts http and https', async () => {
    shared = createSharedServer();
    const seen: string[] = [];
    shared.attachDrive((url) => {
      seen.push(url);
      return Promise.resolve({ sessionId: 's1', ready: true });
    });
    const port = await listen(shared);

    for (const url of ['http://localhost:5173/', 'https://example.com/app']) {
      const res = await post(port, DRIVE_PATH, JSON.stringify({ url }));
      expect(res.status, url).toBe(200);
    }
    expect(seen).toEqual(['http://localhost:5173/', 'https://example.com/app']);
  });

  it('hands the url to the attached provider and returns its session as JSON', async () => {
    shared = createSharedServer();
    const seen: string[] = [];
    shared.attachDrive((url) => {
      seen.push(url);
      return Promise.resolve({ sessionId: 'lease-1', ready: true });
    });
    const port = await listen(shared);
    const res = await post(port, DRIVE_PATH, JSON.stringify({ url: 'http://localhost:5173' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sessionId: 'lease-1', ready: true });
    expect(seen).toEqual(['http://localhost:5173']);
  });

  /**
   * `text/plain`, `application/x-www-form-urlencoded` and `multipart/form-data` are the three CORS
   * SIMPLE content types: a browser sends them cross-origin with NO preflight. Loopback origins are
   * authorized here by design, so without a content-type check any page on any localhost port could
   * guess our port and drive the browser to a URL it chose. Blocking the response afterwards does
   * not un-drive the browser, which is why this is refused before the body is read.
   */
  it.each([
    'text/plain',
    'text/plain;charset=UTF-8',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
  ])('refuses a %s POST and never drives', async (contentType) => {
    shared = createSharedServer();
    const seen: string[] = [];
    shared.attachDrive((url) => {
      seen.push(url);
      return Promise.resolve({ sessionId: 'lease-1', ready: true });
    });
    const port = await listen(shared);
    const res = await post(port, DRIVE_PATH, JSON.stringify({ url: 'http://evil.example/' }), {
      'Content-Type': contentType,
    });
    expect(res.status).toBe(415);
    expect(seen, 'the browser must not have been driven').toEqual([]);
  });

  it('accepts application/json carrying a charset, which real clients send', async () => {
    shared = createSharedServer();
    shared.attachDrive(() => Promise.resolve({ sessionId: 'lease-1', ready: true }));
    const port = await listen(shared);
    const res = await post(port, DRIVE_PATH, JSON.stringify({ url: 'http://localhost:5173' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(res.status).toBe(200);
  });

  it('answers a provider failure as an error field, not a dead socket', async () => {
    // The CLI reads `error` and prints it. A thrown handler that killed the response would leave
    // `drive` hanging on a request that can never answer — the failure mode this whole path exists
    // to remove, in a new place.
    shared = createSharedServer();
    shared.attachDrive(() => Promise.reject(new Error('could not open http://localhost:5173')));
    const port = await listen(shared);
    const res = await post(port, DRIVE_PATH, JSON.stringify({ url: 'http://localhost:5173' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ error: 'could not open http://localhost:5173' });
  });

  it('rejects a request with no url', async () => {
    shared = createSharedServer();
    shared.attachDrive(() => Promise.resolve({ sessionId: 'never', ready: true }));
    const port = await listen(shared);
    const res = await post(port, DRIVE_PATH, JSON.stringify({}));
    expect(res.status).toBe(400);
  });

  it('is 404 when no drive provider is attached, so an old CLI learns nothing is there', async () => {
    shared = createSharedServer();
    const port = await listen(shared);
    const res = await post(port, DRIVE_PATH, JSON.stringify({ url: 'http://localhost:5173' }));
    expect(res.status).toBe(404);
  });

  it('carries the same trust tier as /status — a rebound Host is refused', async () => {
    shared = createSharedServer();
    shared.attachDrive(() => Promise.resolve({ sessionId: 'lease-1', ready: true }));
    const port = await listen(shared);
    const res = await post(port, DRIVE_PATH, JSON.stringify({ url: 'http://localhost:5173' }), {
      host: 'evil.com',
    });
    expect(res.status).toBe(401);
  });
});

/**
 * A daemon that goes quietly is indistinguishable from one that died.
 *
 * The proxy on the other end of this stream sees the same clean socket end either way, so a
 * scheduled retirement and a crash under a live client were one row in the only metric that says
 * whether the agent's tools stay up. The daemon is the only party that knows which it is, and this
 * frame is it saying so. Nothing else in the product can supply the answer — which is why the
 * absence of this write is not visible anywhere downstream.
 */
describe('announceShutdown', () => {
  it('writes a shutdown frame to every open MCP stream before the sockets go', async () => {
    shared = createSharedServer();
    shared.attachMcp(fakeMcpServer);
    const port = await listen(shared);

    const frames: string[] = [];
    const req = await new Promise<http.ClientRequest>((resolve) => {
      const r = http.get({ host: '127.0.0.1', port, path: MCP_SSE_PATH, agent: false }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => frames.push(chunk));
        resolve(r);
      });
      r.on('error', () => undefined);
    });
    await tick();

    shared.announceShutdown();

    await vi.waitFor(() => expect(frames.join('')).toContain(`event: ${MCP_SHUTDOWN_EVENT}`));
    req.destroy();
  });

  /** Nothing attached is the shutdown path of a start that failed. It must not throw on the way out. */
  it('is a no-op when no agent is attached', () => {
    shared = createSharedServer();
    expect(() => shared?.announceShutdown()).not.toThrow();
  });
});

/**
 * A request target the URL parser refuses must not take the daemon down.
 *
 * `new URL(req.url, …)` sat at the top of the request handler, outside any try/catch, and Node's
 * HTTP parser happily accepts targets the WHATWG parser rejects. A sync throw in a `request`
 * listener is an uncaughtException, and the daemon's resilience handler answers those by exiting —
 * correctly, because a process in an undefined state should not keep serving. So one malformed line
 * on the socket ended the daemon, and with it every agent and every browser session attached to it,
 * whichever project they belonged to.
 *
 * It is unauthenticated by construction: the parse happens before the token check it feeds.
 */
describe('a request target the URL parser cannot read', () => {
  it('is answered, not fatal', async () => {
    shared = createSharedServer();
    const port = await listen(shared);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '//', method: 'GET' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    // The proof the process survived: the very next request is served normally.
    expect((await get(port, STATUS_PATH)).status).toBe(200);
  });
});
