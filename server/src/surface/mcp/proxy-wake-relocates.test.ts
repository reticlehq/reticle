/**
 * A wake that finds the port taken goes to the port the wake resolved.
 *
 * The proxy read its port once, at boot. After an idle exit freed that port, another project's
 * daemon could bind it, and every wake then refused with "belongs to a different project" until the
 * client restarted. The wake now returns the port it resolved, and the proxy connects there.
 *
 * Driven over real sockets, like proxy-outage-honesty.test.ts, because the behaviour is in which
 * port the next dial reaches.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LOOPBACK_HOST, MCP_SHUTDOWN_EVENT, MCP_SSE_PATH, STATUS_PATH } from '@reticlehq/core';
import { startMcpProxy } from './mcp-proxy.js';
import { getTelemetry } from '@/telemetry/telemetry.js';

const ENDPOINT_FRAME = 'event: endpoint\ndata: /session/relocate\n\n';
const SHUTDOWN_FRAME = `event: ${MCP_SHUTDOWN_EVENT}\ndata: {}\n\n`;

const clientCall = (id: number): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`;

interface FakeDaemon {
  port: number;
  streams: http.ServerResponse[];
  posts: string[];
  close: () => Promise<void>;
}

function startFakeDaemon(): Promise<FakeDaemon> {
  const streams: http.ServerResponse[] = [];
  const posts: string[] = [];
  const server = http.createServer((req, res) => {
    if ('GET' === req.method && (req.url ?? '').startsWith(STATUS_PATH)) {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ running: true, version: '0.0.0', sessions: [] }));
      return;
    }
    if ('POST' === req.method) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        posts.push(body);
        res.writeHead(202).end();
      });
      return;
    }
    if (!(req.url ?? '').startsWith(MCP_SSE_PATH)) {
      res.writeHead(404).end();
      return;
    }
    streams.push(res);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(ENDPOINT_FRAME);
  });
  return new Promise<FakeDaemon>((resolve) => {
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        streams,
        posts,
        close: () =>
          new Promise<void>((done) => {
            for (const stream of streams) {
              stream.socket?.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

describe('a wake that resolves another port', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('connects to the port the wake returned, not the port it booted on', async () => {
    vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'reticle-wake-relocates-')));
    const first = await startFakeDaemon();
    let moved: FakeDaemon | undefined;
    const stdin = new PassThrough({ encoding: 'utf8' });
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    cleanups.push(() => {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
      stdin.destroy();
    });
    void startMcpProxy(first.port, async () => {
      moved ??= await startFakeDaemon();
      cleanups.push(() => moved?.close());
      return moved.port;
    }).catch(() => undefined);
    stdin.write(clientCall(1));
    await vi.waitFor(() => expect(first.posts.length).toBe(1));

    // The daemon retires and frees the port.
    first.streams[0]?.write(SHUTDOWN_FRAME);
    first.streams[0]?.end();
    await first.close();

    // Keep asking until a request lands after the proxy went dormant: that one is the wake.
    let id = 2;
    await vi.waitFor(
      () => {
        stdin.write(clientCall(id++));
        expect(moved?.posts.length ?? 0).toBeGreaterThan(0);
      },
      { timeout: 20_000, interval: 250 },
    );
  }, 30_000);
});
