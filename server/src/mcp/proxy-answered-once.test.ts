/**
 * A request the proxy has already answered must never be posted to the daemon afterwards.
 *
 * Every client line is recorded in `pending` whether it goes straight out or waits in the stdin
 * queue, so a queued request is in BOTH. When a stream drops, the proxy answers everything `pending`
 * owes — correctly, because the dead session cannot — and then reconnects. The queue was left alone,
 * so the next `endpoint` frame flushed it into the new session, the daemon answered the same id a
 * second time, and the client saw two responses for one request. That is a corrupted stream, and the
 * client has no way to tell which reply to believe.
 *
 * The proxy already knows this shape: the local handshake removes its line from the queue before
 * answering it, for exactly this reason, in a comment that calls the double answer "worse than the
 * hang this replaces". The stream-loss path owed the same courtesy and did not pay it.
 *
 * Reachable whenever a request is queued and the stream carrying the reconnect dies before it hands
 * over an endpoint — a daemon that accepts SSE and is still booting, or one killed mid-restart. The
 * test reproduces that literally: the second stream serves headers and no endpoint frame.
 *
 * Asserted at the POST rather than at stdout, deliberately. The second reply is the daemon's, so a
 * fake daemon that never sends one would let the defect pass; what the proxy is responsible for is
 * not handing a settled request to anybody, and that is a fact about its own outbound traffic.
 *
 * Reported in https://github.com/reticlehq/reticle/pull/300.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LOOPBACK_HOST, MCP_SSE_PATH, STATUS_PATH } from '@reticlehq/core';
import { startMcpProxy } from './mcp-proxy.js';
import { resetOutageReporting } from './mcp-outage.js';

const SSE_HEADERS = { 'content-type': 'text/event-stream' } as const;
const endpointFrame = (n: number): string =>
  `event: endpoint\ndata: /session/answered-once-${n}\n\n`;

const clientCall = (id: number): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`;

/** Long enough that a flush of the stale queue would have posted. A settle, not a deadline. */
const SETTLE_MS = 1_500;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

interface FakeDaemon {
  port: number;
  streams: http.ServerResponse[];
  posts: string[];
  /**
   * Stream indexes that get headers and no `endpoint` frame — a daemon accepting SSE while it is
   * still coming up. The proxy holds `postUrl` at null against one of these, which is the state that
   * puts a request in the queue and in `pending` at the same time.
   */
  withholdEndpoint: Set<number>;
  close: () => Promise<void>;
}

function startFakeDaemon(): Promise<FakeDaemon> {
  const streams: http.ServerResponse[] = [];
  const posts: string[] = [];
  const withholdEndpoint = new Set<number>();
  const server = http.createServer((req, res) => {
    // A Reticle daemon answers `/status`, and the proxy's drop path now asks: a port that accepts
    // SSE and does not serve status is a stranger, not a daemon, and must not be reattached to.
    // A fake that skips this is claiming to be a daemon while behaving like the squatter.
    if ('GET' === req.method && (req.url ?? '').startsWith(STATUS_PATH)) {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ running: true }));
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
    const index = streams.length;
    streams.push(res);
    res.writeHead(200, SSE_HEADERS);
    if (!withholdEndpoint.has(index)) res.write(endpointFrame(index));
  });
  return new Promise<FakeDaemon>((resolve) => {
    server.listen(0, LOOPBACK_HOST, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        streams,
        posts,
        withholdEndpoint,
        close: () =>
          new Promise<void>((done) => {
            for (const stream of streams) stream.socket?.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const postsFor = (daemon: FakeDaemon, id: number): string[] =>
  daemon.posts.filter((body) => body.includes(`"id":${id}`));

describe('a settled request is never posted', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetOutageReporting();
  });

  function driveProxy(port: number): PassThrough {
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'reticle-proxy-log-')));
    const stdin = new PassThrough({ encoding: 'utf8' });
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    void startMcpProxy(port).catch(() => {});
    cleanups.push(() => {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
      stdin.destroy();
    });
    return stdin;
  }

  it('drops the queue it just answered, so a reconnect cannot post it again', async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    // The reconnect after the first drop serves headers and no endpoint: a daemon still booting.
    daemon.withholdEndpoint.add(1);

    const stdin = driveProxy(daemon.port);
    // The barrier. A post only lands once the proxy has processed stream 0's `endpoint` frame, so
    // reaching it proves the session is live rather than merely opened.
    stdin.write(clientCall(1));
    await vi.waitFor(() => expect(daemon.posts.length).toBe(1));

    daemon.streams[0]?.end();
    await vi.waitFor(() => expect(daemon.streams.length).toBe(2));

    // Stream 1 hands over no endpoint, so this queues. It is now in the queue AND in `pending`.
    stdin.write(clientCall(2));
    await settle();
    expect(postsFor(daemon, 2), 'nothing to post yet: there is no session').toEqual([]);

    // The drop answers id 2 with a stream-loss reply, because the dead session never will.
    (daemon.streams[1]?.socket as Socket).resetAndDestroy();

    // Stream 2 is a healthy session. Before the fix, its endpoint frame flushed the stale queue and
    // handed the daemon a request the client had already been answered for.
    await vi.waitFor(() => expect(daemon.streams.length).toBe(3));
    await settle();

    expect(
      postsFor(daemon, 2),
      'this request was already answered by the stream-loss path; posting it means the daemon ' +
        'answers the same id a second time and the client sees two responses for one request',
    ).toEqual([]);

    stdin.destroy();
    await settle();
    // Generous, and a timeout rather than a duration assertion on purpose: the test spends two
    // settles waiting for a post that must never arrive, and nothing here claims the proxy is fast.
  }, 30_000);
});
