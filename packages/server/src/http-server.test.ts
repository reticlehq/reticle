import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSharedServer, MCP_SSE_PATH, STATUS_PATH, type SharedServer } from './http-server.js';

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

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
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
    // The token gate must never break the local stdio proxy / `iris status`, which always dial 127.0.0.1.
    shared = createSharedServer({ token: 'a-secret-pairing-token' });
    const port = await listen(shared);
    const res = await get(port, STATUS_PATH);
    expect(res.status).toBe(200);
  });
});

/**
 * A no-op McpServer good enough to drive the SSE presence path. connect() starts the transport so the
 * SSE response headers flush (the client GET resolves); close() is a noop.
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
    req.on('error', () => undefined); // destroy() surfaces as ECONNRESET — expected, ignore
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
