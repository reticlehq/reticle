/**
 * The outage metric has to be able to say something other than what it always said.
 *
 * As shipped, `mcp_connection_lost` reported `stage: first` with `attempts: 1` on every single event
 * it ever produced, and could not have produced another value: the stage is emitted at the instant of
 * the drop, when the attempt counter has just been raised from zero, and the once-per-stage cap keeps
 * any later drop from replacing it. Read as "reconnection never advances past the first attempt" it
 * looks like a transport that cannot recover. It is really a metric with one degree of freedom.
 *
 * Two facts were missing and both are here. Whether the link CAME BACK, and what that cost — without
 * it `first` is unfalsifiable. And whether the stream ended because the daemon retired on schedule,
 * which is a clean socket end indistinguishable from a daemon dying under a live client unless the
 * daemon says so before it goes.
 *
 * Driven over a real socket, like the fan-out spec next door and for the same reason: the whole
 * behaviour lives in which Node events fire in which order, and a stubbed `http` would agree with any
 * implementation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  LOOPBACK_HOST,
  MCP_SSE_PATH,
  MCP_SHUTDOWN_EVENT,
  OutageReason,
  OutageStage,
  STATUS_PATH,
  TelemetryEventKind,
} from '@reticlehq/core';
import { startMcpProxy } from './mcp-proxy.js';
import { resetOutageReporting } from './mcp-outage.js';
import { getTelemetry } from '../telemetry/telemetry.js';

const SESSION_PATH = '/session/honesty';
const SSE_HEADERS = { 'content-type': 'text/event-stream' } as const;
const ENDPOINT_FRAME = `event: endpoint\ndata: ${SESSION_PATH}\n\n`;
const SHUTDOWN_FRAME = `event: ${MCP_SHUTDOWN_EVENT}\ndata: {}\n\n`;

const clientCall = (id: number): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`;

interface FakeDaemon {
  port: number;
  streams: http.ServerResponse[];
  posts: string[];
  /** Refuse the next `n` SSE dials with a body that ends immediately — a daemon that is not serving. */
  refuseDials: number;
  close: () => Promise<void>;
}

/**
 * A daemon that serves SSE for real and can refuse a dial without going away.
 *
 * The refusal is what makes the recovered attempt count mean anything: a reconnect that succeeds
 * first time reports 1, which is the number the broken metric already reported, so a test built on
 * one would pass against the defect.
 */
function startFakeDaemon(): Promise<FakeDaemon> {
  const streams: http.ServerResponse[] = [];
  const posts: string[] = [];
  const state = { refuseDials: 0 };
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
    if (0 < state.refuseDials) {
      state.refuseDials -= 1;
      res.writeHead(503).end();
      return;
    }
    streams.push(res);
    res.writeHead(200, SSE_HEADERS);
    res.write(ENDPOINT_FRAME);
  });
  return new Promise<FakeDaemon>((resolve) => {
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        streams,
        posts,
        get refuseDials(): number {
          return state.refuseDials;
        },
        set refuseDials(n: number) {
          state.refuseDials = n;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const stream of streams) stream.socket?.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

interface OutagePayload {
  stage: string;
  reason: string;
  attempts: number;
}

describe('what an outage event is allowed to say', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetOutageReporting();
  });

  /** Every outage this process has emitted SO FAR. Read again after each step, never snapshotted. */
  function outageReader(): () => OutagePayload[] {
    const emit = vi.spyOn(getTelemetry(), 'emit').mockResolvedValue(true);
    return () =>
      emit.mock.calls
        .filter((call) => TelemetryEventKind.MCP_CONNECTION_LOST === call[0])
        .map((call) => (call[1] as { outage: OutagePayload }).outage);
  }

  function driveProxy(port: number): PassThrough {
    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'reticle-outage-honesty-')));
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

  /**
   * The daemon retiring on schedule is not the agent losing its tools, and on the socket it looks
   * exactly like one. Every event in the field carried the ambiguous reason.
   */
  it('calls an announced shutdown a shutdown, not a stream that ended for no reason', async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    const seen = outageReader();
    const stdin = driveProxy(daemon.port);
    stdin.write(clientCall(1));
    await vi.waitFor(() => expect(daemon.posts.length).toBe(1));

    // What the daemon does on its way out: say so, then close.
    daemon.streams[0]?.write(SHUTDOWN_FRAME);
    daemon.streams[0]?.end();

    await vi.waitFor(() => expect(seen().length).toBeGreaterThan(0));
    expect(seen()[0]?.stage).toBe(OutageStage.FIRST);
    expect(seen()[0]?.reason).toBe(OutageReason.DAEMON_SHUTDOWN);
  });

  /** Unannounced, the same clean end is exactly what it was before — and must stay so. */
  it('still calls an unannounced end an unexplained one', async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    const seen = outageReader();
    const stdin = driveProxy(daemon.port);
    stdin.write(clientCall(1));
    await vi.waitFor(() => expect(daemon.posts.length).toBe(1));

    daemon.streams[0]?.end();

    await vi.waitFor(() => expect(seen().length).toBeGreaterThan(0));
    expect(seen()[0]?.reason).toBe(OutageReason.SSE_ENDED);
  });

  /**
   * The falsifier. Without a recovery event, `first` says the tools went away and nothing ever says
   * they came back — so a session that recovered in 500ms and one that never recovered at all are
   * the same row, and the attempt count on the drop is 1 whatever the transport actually did.
   */
  it('reports that the link came back, and what it cost', async () => {
    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    const seen = outageReader();
    const stdin = driveProxy(daemon.port);
    stdin.write(clientCall(1));
    await vi.waitFor(() => expect(daemon.posts.length).toBe(1));

    // Two dials refused before one is served, so a recovery that costs three attempts cannot be
    // confused with the constant the drop event already reported.
    daemon.refuseDials = 2;
    daemon.streams[0]?.end();

    await vi.waitFor(
      () => expect(seen().some((o) => OutageStage.RECOVERED === o.stage)).toBe(true),
      { timeout: 10_000 },
    );
    const recovered = seen().find((o) => OutageStage.RECOVERED === o.stage);
    expect(recovered?.attempts).toBe(3);
    expect(recovered?.reason).toBe(OutageReason.SSE_ENDED);
  }, 20_000);
});
