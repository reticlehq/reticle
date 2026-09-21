/**
 * A POST that fails is not the agent losing its tools.
 *
 * The forward path reported `first` / `connect_error` when a POST leg died, while the SSE stream was
 * still up — which the telemetry contract forbids in as many words, because `postSocketFailures` on
 * the session summary already counts exactly that. The double count was the smaller half: the outage
 * cap is once per process, so a transient POST failure in the first minute permanently suppressed
 * the real stream outage in the fortieth, and a low outage count read as a transport that had been
 * fixed.
 *
 * Its own file rather than another case beside the outage specs, because it asserts an ABSENCE and
 * every spec in that file leaves a live proxy whose own reconnects land in the next reader. Driven
 * over a real socket for the reason the neighbours are: the behaviour is which Node events fire in
 * which order, and a stubbed `http` would agree with any implementation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LOOPBACK_HOST, MCP_SSE_PATH, STATUS_PATH, TelemetryEventKind } from '@reticlehq/core';
import { startMcpProxy } from './mcp-proxy.js';
import { resetOutageReporting } from './faults/mcp-outage.js';
import { getTelemetry } from '@/telemetry/telemetry.js';

const SESSION_PATH = '/session/post-failure';
const SSE_HEADERS = { 'content-type': 'text/event-stream' } as const;
const ENDPOINT_FRAME = `event: endpoint\ndata: ${SESSION_PATH}\n\n`;
const CLIENT_CALL = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`;

interface FakeDaemon {
  port: number;
  posts: string[];
  close: () => Promise<void>;
}

/**
 * A daemon that serves SSE for real and kills the socket under every POST.
 *
 * The stream is deliberately left untouched: the whole claim under test is that a dead POST leg and
 * a lost stream are different facts, and a fake that dropped both could not tell them apart either.
 */
function startFakeDaemon(): Promise<FakeDaemon> {
  const streams: http.ServerResponse[] = [];
  const posts: string[] = [];
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
        req.socket.destroy();
      });
      return;
    }
    if (!(req.url ?? '').startsWith(MCP_SSE_PATH)) {
      res.writeHead(404).end();
      return;
    }
    streams.push(res);
    res.writeHead(200, SSE_HEADERS);
    res.write(ENDPOINT_FRAME);
  });
  return new Promise<FakeDaemon>((resolve) => {
    server.listen(0, LOOPBACK_HOST, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        posts,
        close: () =>
          new Promise<void>((done) => {
            for (const stream of streams) stream.socket?.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

describe('a dead POST leg is not an outage', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetOutageReporting();
  });

  it('reports no lost stream when the stream it belongs to is still up', async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    const outages = (): unknown[] =>
      emit.mock.calls.filter((call) => TelemetryEventKind.MCP_CONNECTION_LOST === call[0]);

    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'reticle-post-failure-')));
    const stdin = new PassThrough({ encoding: 'utf8' });
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    void startMcpProxy(daemon.port).catch(() => {});
    cleanups.push(() => {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
      stdin.destroy();
    });

    stdin.write(CLIENT_CALL);

    // Waited on the OBSERVABLE the failure produces, not on a clock: the proxy owes every call it
    // was holding an answer, so the transport-loss reply going out under id 1 is the proof that the
    // failure path ran and there is something to assert about.
    await vi.waitFor(
      () => expect(stdout.mock.calls.some((call) => /"id":1/.test(String(call[0])))).toBe(true),
      { timeout: 15_000 },
    );
    expect(daemon.posts.length, 'the POST must have reached the daemon to have failed').toBe(1);
    expect(outages(), 'a dead POST leg must never be reported as a lost stream').toEqual([]);
  }, 20_000);
});
