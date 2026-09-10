/**
 * `initialize` must be answered exactly once, and never with a transport error.
 *
 * Three parties can answer the client's handshake: the daemon, the stream-loss drain, and the local
 * handshake timer. `PendingRequests.take` is the coordination between them — "claim ONE unanswered
 * id, so exactly one path may answer it" — and the local-handshake path was the one answerer that
 * never claimed. So the drain paid the same id first.
 *
 * Reproduced against a plain HTTP server on the bridge port (a stranger, a wedged process, another
 * tool that grabbed 4400). It answers the SSE GET and closes, which the proxy reads as a stream drop:
 *
 *   +193ms    id=1  error -32001 "the daemon connection dropped (sse_ended) ... retry"
 *   +12193ms  id=1  result  (the local handshake, under the SAME id)
 *
 * Both halves are defects and they are the same defect. An MCP client that gets an error for
 * `initialize` marks the server failed and never sends another line — the agent's Reticle tools are
 * gone for the session, with nothing to retry them. A client that survives that then receives a
 * second response for an id it has already settled, which is a JSON-RPC protocol violation.
 *
 * The proxy has its own answer for this one request and always delivers it, so the transport-loss
 * path was never the party that owed it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LOOPBACK_HOST } from '@reticlehq/core';
import { startMcpProxy } from './mcp-proxy.js';
import { resetOutageReporting } from './mcp-outage.js';

const INITIALIZE_ID = 1;

const initializeLine = (): string =>
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: INITIALIZE_ID,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'rca', version: '0' },
    },
  })}\n`;

/**
 * A stranger on the bridge port: accepts, answers, and closes. Not a daemon, and not wedged — the
 * shape that produces the reconnect churn, because every attempt "succeeds" and then ends.
 */
function startSquatter(): Promise<{ port: number; hits: number[]; close: () => Promise<void> }> {
  const hits: number[] = [];
  const server = http.createServer((_req, res) => {
    hits.push(Date.now());
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not reticle');
  });
  return new Promise((resolve) => {
    server.listen(0, LOOPBACK_HOST, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        hits,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

interface JsonRpcReply {
  id?: unknown;
  error?: { code?: number; message?: string };
  result?: unknown;
}

describe('the handshake against a port a stranger holds', () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetOutageReporting();
  });

  it('is answered once, and not with a transport error', async () => {
    const squatter = await startSquatter();
    cleanups.push(() => squatter.close());

    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'reticle-proxy-log-')));
    const stdin = new PassThrough({ encoding: 'utf8' });
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    const replies: JsonRpcReply[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      for (const line of String(chunk).split('\n')) {
        if ('' === line.trim()) continue;
        try {
          replies.push(JSON.parse(line) as JsonRpcReply);
        } catch {
          // not a JSON-RPC line — nothing this test asserts about
        }
      }
      return true;
    });
    void startMcpProxy(squatter.port).catch(() => undefined);
    cleanups.push(() => {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
      stdin.destroy();
    });

    stdin.write(initializeLine());

    // The local handshake is the answer this request is owed; wait until it has been delivered.
    //
    // The bound is the point, not the duration. LOCAL_HANDSHAKE_MS is 12s, and it is a timeout for
    // the case where the proxy CANNOT TELL what is on the port — "long enough for a cold daemon
    // start". Against a stranger it can tell, in one probe, and #125 records what waiting out that
    // timer costs: any MCP client configured below ~12s loses Reticle for the entire session with
    // no way to tell why. So this waits a fraction of it: passing means the answer did not come
    // from that timer.
    await vi.waitFor(
      () => {
        expect(replies.filter((r) => r.id === INITIALIZE_ID).length).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 100 },
    );
    // Then keep watching: the second answer, when it came, came from the other path entirely.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const answers = replies.filter((r) => r.id === INITIALIZE_ID);
    expect(
      answers.map((a) => (a.error === undefined ? 'result' : `error ${String(a.error.code)}`)),
      'two responses for one id is a corrupted stream, and an error on initialize makes the client ' +
        'mark the whole MCP server failed',
    ).toEqual(['result']);
  }, 40_000);

  it('refuses a tool call with the reason instead of twenty seconds of silence', async () => {
    const squatter = await startSquatter();
    cleanups.push(() => squatter.close());

    vi.stubEnv('HOME', mkdtempSync(join(tmpdir(), 'reticle-proxy-log-')));
    const stdin = new PassThrough({ encoding: 'utf8' });
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    const replies: JsonRpcReply[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      for (const line of String(chunk).split('\n')) {
        if ('' === line.trim()) continue;
        try {
          replies.push(JSON.parse(line) as JsonRpcReply);
        } catch {
          // not a JSON-RPC line
        }
      }
      return true;
    });
    // The wake path is what learns the port is unusable, and it only runs once the proxy is dormant
    // — which is where the handshake above leaves it.
    void startMcpProxy(squatter.port, () =>
      Promise.reject(new Error(`port ${String(squatter.port)} is held by another process`)),
    ).catch(() => undefined);
    cleanups.push(() => {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
      stdin.destroy();
    });

    stdin.write(initializeLine());
    await vi.waitFor(
      () => {
        expect(replies.filter((r) => r.id === INITIALIZE_ID).length).toBe(1);
      },
      { timeout: 5_000, interval: 100 },
    );

    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call' })}\n`);

    // QUEUE_WAIT_MS is 20s and it is the timeout for "we still believe a session is coming". Once
    // the wake has failed, nothing is coming, and holding the caller for the rest of that window
    // buys the agent nothing but a slower version of the same refusal.
    await vi.waitFor(
      () => {
        expect(replies.filter((r) => 7 === r.id).length).toBe(1);
      },
      { timeout: 8_000, interval: 100 },
    );
    const refusal = replies.find((r) => 7 === r.id);
    expect(refusal?.error?.code).toBe(-32001);
    expect(
      refusal?.error?.message ?? '',
      'a refusal that does not name what is on the port sends the reader nowhere',
    ).toContain('is held by another process');
  }, 40_000);
});
