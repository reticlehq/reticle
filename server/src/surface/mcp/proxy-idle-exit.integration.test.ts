import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { LOOPBACK_HOST, MCP_SSE_PATH, ReticleEnv, STATUS_PATH } from '@reticlehq/core';
import { proxyLogPath, setProxyLogPort, startMcpProxy } from './mcp-proxy.js';
import { PROXY_IDLE_EXIT_EVENT } from './proxy-idle-exit.js';

interface FakeDaemon {
  port: number;
  stream: http.ServerResponse | undefined;
  posts: string[];
  close: () => Promise<void>;
}

function startFakeDaemon(): Promise<FakeDaemon> {
  let stream: http.ServerResponse | undefined;
  const posts: string[] = [];
  const server = http.createServer((req, res) => {
    if ('GET' === req.method && (req.url ?? '').startsWith(STATUS_PATH)) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"running":true}');
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
    stream = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: endpoint\ndata: /session/idle-exit\n\n');
  });
  return new Promise<FakeDaemon>((resolve) => {
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        get stream() {
          return stream;
        },
        posts,
        close: () =>
          new Promise<void>((done) => {
            stream?.socket?.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const request = (id: number): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`;

const response = (id: number): string =>
  `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } })}\n\n`;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the MCP proxy idle exit wired through the real transport', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  let stdoutSpy: MockInstance | undefined;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    stdoutSpy?.mockRestore();
    stdoutSpy = undefined;
    vi.unstubAllEnvs();
  });

  it('keeps an unanswered call alive, then exits after the settled link stays quiet', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reticle-proxy-idle-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv(ReticleEnv.STATE_DIR, home);
    vi.stubEnv(ReticleEnv.MCP_PROXY_IDLE, '500');

    const daemon = await startFakeDaemon();
    cleanups.push(() => daemon.close());
    setProxyLogPort(daemon.port);

    const stdin = new PassThrough({ encoding: 'utf8' });
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    cleanups.push(() => {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
      stdin.destroy();
    });

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const exit = vi.fn<(code: number) => void>();

    void startMcpProxy(daemon.port, undefined, exit).catch(() => undefined);
    stdin.write(request(42));
    await vi.waitFor(() =>
      expect(daemon.posts.some((body) => body.includes('"id":42'))).toBe(true),
    );

    await wait(1_100);
    expect(
      exit,
      'an in-flight request must not be dropped by the idle reaper',
    ).not.toHaveBeenCalled();

    daemon.stream?.write(response(42));
    await vi.waitFor(() =>
      expect(stdoutSpy?.mock.calls.some((call) => String(call[0]).includes('"id":42'))).toBe(true),
    );
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2_000 });

    expect(readFileSync(proxyLogPath(daemon.port), 'utf8')).toContain(
      `"event":${JSON.stringify(PROXY_IDLE_EXIT_EVENT)}`,
    );
  }, 10_000);
});
