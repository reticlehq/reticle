/**
 * Compound failure sequences the proxy must survive.
 *
 * The existing tests pin single-event invariants: one drop → one reconnect, one loss → one error
 * reply, one handshake → one suppressed echo. This file proves those invariants COMPOSE — that a
 * proxy exercised by sequences of failures (rapid successive drops, concurrent in-flight calls
 * across a kill, a replay that dies mid-flight, a queue that flushes while fresh traffic arrives)
 * stays correct without leaking state, duplicating answers, or silently dropping requests.
 *
 * Every scenario is reported from production telemetry: ~8 SSE aborts/day across 54 users, 172
 * connection-lost events total. The harm is proportional to the compound effects — not any single
 * drop, but what happens when two drops land before the first reconnect finishes.
 *
 * Driven over real sockets, following `proxy-reconnect-fanout.test.ts` and its reasoning: the
 * whole behaviour lives in which Node events fire in which order, and a stubbed `http` would pass
 * against the defect.
 */

import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LOOPBACK_HOST, MCP_SSE_PATH, STATUS_PATH } from '@reticlehq/core';
import { RECONNECT_INITIALIZE_ID, startMcpProxy } from './mcp-proxy.js';
import { resetOutageReporting } from './mcp-outage.js';

const SSE_HEADERS = { 'content-type': 'text/event-stream' } as const;

const clientCall = (id: number): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`;

/**
 * A REAL handshake, which the replay test cannot do without.
 *
 * `HandshakeReplay.replayLines()` returns nothing until it has observed an `initialize` going out.
 * A client that only ever sends `tools/list` therefore triggers no replay at all, so a test that
 * drops a stream mid-"replay" is not exercising one.
 */
const clientInitialize = (id: number): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: {} })}\n`;

const SETTLE_MS = 1_500;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

interface FakeDaemon {
  port: number;
  streams: http.ServerResponse[];
  posts: string[];
  /** Stream indexes where the endpoint frame is withheld (daemon accepting SSE but still booting). */
  withholdEndpoint: Set<number>;
  /**
   * Answer the proxy's replayed handshake, the way a real daemon does.
   *
   * Off by default so the other cases keep their existing traffic. The leak assertion in the replay
   * case is meaningless without it: if nothing ever carries `RECONNECT_INITIALIZE_ID` back over the
   * stream, "no replayed initialize reached stdout" is true no matter what the proxy does with it.
   */
  echoReplayedHandshake: { on: boolean };
  close: () => Promise<void>;
}

function startFakeDaemon(): Promise<FakeDaemon> {
  const streams: http.ServerResponse[] = [];
  const posts: string[] = [];
  const withholdEndpoint = new Set<number>();
  const echoReplayedHandshake = { on: false };
  const server = http.createServer((req, res) => {
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
        // The daemon answers the replayed initialize under the reserved id. Whether that answer
        // reaches the client is the proxy's decision, and the whole point of the assertion below.
        if (echoReplayedHandshake.on && body.includes(RECONNECT_INITIALIZE_ID)) {
          const live = streams[streams.length - 1];
          live?.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: RECONNECT_INITIALIZE_ID,
              result: {},
            })}\n\n`,
          );
        }
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
    if (!withholdEndpoint.has(index)) {
      res.write(`event: endpoint\ndata: /session/chaos-${String(index)}\n\n`);
    }
  });
  return new Promise<FakeDaemon>((resolve) => {
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        streams,
        posts,
        withholdEndpoint,
        echoReplayedHandshake,
        close: () =>
          new Promise<void>((done) => {
            for (const stream of streams) stream.socket?.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

describe('MCP proxy chaos — compound failure sequences', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetOutageReporting();
  });

  let stdoutSpy: MockInstance;

  function driveProxy(port: number): PassThrough {
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'reticle-chaos-')));
    const stdin = new PassThrough({ encoding: 'utf8' });
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    void startMcpProxy(port).catch(() => {});
    cleanups.push(() => {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
      stdin.destroy();
    });
    return stdin;
  }

  function stdoutLines(): string[] {
    return stdoutSpy.mock.calls
      .map((call) => ('string' === typeof call[0] ? call[0] : ''))
      .filter((line) => '' !== line);
  }

  describe('flapping link — rapid successive drops', () => {
    it('survives three drops in quick succession without fan-out or stale state', async () => {
      const daemon = await startFakeDaemon();
      cleanups.push(() => daemon.close());
      const stdin = driveProxy(daemon.port);

      // Establish the first session — barrier: a post proves the endpoint was processed.
      stdin.write(clientCall(1));
      await vi.waitFor(() => expect(daemon.posts.length).toBe(1));

      // Drop 1: kill stream 0.
      (daemon.streams[0]?.socket as Socket).resetAndDestroy();
      await vi.waitFor(() => expect(daemon.streams.length).toBe(2));

      // Drop 2: kill stream 1 immediately after it appears.
      (daemon.streams[1]?.socket as Socket).resetAndDestroy();
      await vi.waitFor(() => expect(daemon.streams.length).toBe(3));

      // Drop 3: kill stream 2 as well.
      (daemon.streams[2]?.socket as Socket).resetAndDestroy();
      await vi.waitFor(() => expect(daemon.streams.length).toBe(4));

      // Stream 3 stays alive. Verify the proxy is still functional.
      await settle();
      expect(daemon.streams.length).toBe(4);
    }, 20_000);

    it('answers a client request that arrives after the third reconnect', async () => {
      const daemon = await startFakeDaemon();
      cleanups.push(() => daemon.close());
      const stdin = driveProxy(daemon.port);

      stdin.write(clientCall(1));
      await vi.waitFor(() => expect(daemon.posts.length).toBe(1));

      // Three rapid drops.
      (daemon.streams[0]?.socket as Socket).resetAndDestroy();
      await vi.waitFor(() => expect(daemon.streams.length).toBe(2));
      (daemon.streams[1]?.socket as Socket).resetAndDestroy();
      await vi.waitFor(() => expect(daemon.streams.length).toBe(3));
      (daemon.streams[2]?.socket as Socket).resetAndDestroy();
      await vi.waitFor(() => expect(daemon.streams.length).toBe(4));

      // Now send a fresh call — it must arrive at the daemon.
      stdin.write(clientCall(99));
      await vi.waitFor(() => {
        const fresh = daemon.posts.find((p) => p.includes('"id":99'));
        expect(fresh).toBeDefined();
      });
    }, 20_000);
  });

  describe('concurrent in-flight calls across a drop', () => {
    it('answers every in-flight request exactly once when the stream dies under load', async () => {
      const daemon = await startFakeDaemon();
      cleanups.push(() => daemon.close());
      const stdin = driveProxy(daemon.port);

      // Establish connection.
      stdin.write(clientCall(1));
      await vi.waitFor(() => expect(daemon.posts.length).toBe(1));

      // Send 5 calls. The daemon accepts the POSTs but never sends a response — simulating slow.
      for (let i = 10; 15 > i; i++) stdin.write(clientCall(i));
      await vi.waitFor(() => {
        const inFlight = daemon.posts.filter((p) => p.includes('"id":1') || /"id":1[0-4]/.test(p));
        expect(inFlight.length).toBeGreaterThanOrEqual(5);
      });

      // Kill the stream while all 5 are in flight (unanswered).
      (daemon.streams[0]?.socket as Socket).resetAndDestroy();

      // Wait for error replies to arrive on stdout.
      await vi.waitFor(() => {
        const errorReplies = stdoutLines().filter((line) => line.includes('-32001'));
        expect(errorReplies.length).toBeGreaterThanOrEqual(5);
      });

      // Each id 10-14 must have exactly one error reply.
      const errorReplies = stdoutLines().filter((line) => line.includes('-32001'));
      for (let i = 10; 15 > i; i++) {
        const matches = errorReplies.filter((line) => line.includes(`"id":${String(i)}`));
        expect(matches.length, `id ${String(i)} must be answered exactly once`).toBe(1);
      }
    }, 20_000);
  });

  describe('drop during handshake replay', () => {
    it('replays correctly into the THIRD session after two die mid-replay', async () => {
      const daemon = await startFakeDaemon();
      cleanups.push(() => daemon.close());

      // Stream 1 will die before answering the replayed initialize.
      daemon.withholdEndpoint.add(1);
      // And the daemon answers the replay, so there is something that COULD leak.
      daemon.echoReplayedHandshake.on = true;

      const stdin = driveProxy(daemon.port);

      // A real handshake first: without one there is nothing to replay, and every assertion about
      // the replay below would hold over a replay that never happened.
      stdin.write(clientInitialize(0));
      stdin.write(clientCall(1));
      await vi.waitFor(() => expect(daemon.posts.length).toBeGreaterThanOrEqual(1));

      // Drop stream 0 — triggers reconnect + handshake replay on stream 1.
      (daemon.streams[0]?.socket as Socket).resetAndDestroy();
      await vi.waitFor(() => expect(daemon.streams.length).toBe(2));

      // Stream 1 has no endpoint frame (withheld) and dies.
      await settle();
      (daemon.streams[1]?.socket as Socket).resetAndDestroy();

      // Stream 2 connects normally (not in withholdEndpoint set).
      await vi.waitFor(() => expect(daemon.streams.length).toBe(3));

      // The proxy must still be alive and functional after stream 2 connects.
      stdin.write(clientCall(50));
      await vi.waitFor(() => {
        const found = daemon.posts.find((p) => p.includes('"id":50'));
        expect(found).toBeDefined();
      });

      // The replay must actually have HAPPENED, or the leak check below proves nothing.
      const replayed = daemon.posts.filter((p) => p.includes(RECONNECT_INITIALIZE_ID));
      expect(
        replayed.length,
        'no replayed initialize was ever posted — the leak assertion would be vacuous',
      ).toBeGreaterThanOrEqual(1);

      // The daemon answered it (echoReplayedHandshake), and the proxy must swallow that answer:
      // a duplicate JSON-RPC id on the client's stdout is a protocol violation.
      const leaked = stdoutLines().filter((line) => line.includes(RECONNECT_INITIALIZE_ID));
      expect(leaked.length, 'replayed initialize must not leak to client').toBe(0);
    }, 20_000);
  });

  describe('queue flush under continued client traffic', () => {
    it('delivers queued AND fresh requests in order, without duplicates', async () => {
      const daemon = await startFakeDaemon();
      cleanups.push(() => daemon.close());

      // Withhold endpoint on stream 0 — requests will queue.
      daemon.withholdEndpoint.add(0);

      const stdin = driveProxy(daemon.port);
      await vi.waitFor(() => expect(daemon.streams.length).toBe(1));

      // Send 3 calls while there is no endpoint (they queue).
      stdin.write(clientCall(1));
      stdin.write(clientCall(2));
      stdin.write(clientCall(3));

      // Give time for them to queue (they cannot be posted — no endpoint).
      await settle();
      expect(daemon.posts.length).toBe(0);

      // Now serve the endpoint frame — triggers queue flush.
      daemon.streams[0]?.write(`event: endpoint\ndata: /session/chaos-flush\n\n`);

      // Immediately send 2 more calls while the flush may still be in progress.
      stdin.write(clientCall(4));
      stdin.write(clientCall(5));

      // All 5 must arrive.
      await vi.waitFor(() => expect(daemon.posts.length).toBeGreaterThanOrEqual(5));

      // Each id must appear exactly once.
      for (let i = 1; 6 > i; i++) {
        const matches = daemon.posts.filter((p) => p.includes(`"id":${String(i)}`));
        expect(matches.length, `id ${String(i)} posted exactly once`).toBe(1);
      }

      // Ordering: ids 1-3 (queued) must arrive before ids 4-5 (fresh).
      const firstFresh = daemon.posts.findIndex((p) => p.includes('"id":4'));
      const lastQueued = daemon.posts.findIndex((p) => p.includes('"id":3'));
      expect(lastQueued).toBeLessThan(firstFresh);
    }, 20_000);
  });
});
