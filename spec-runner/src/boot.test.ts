import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { bootSession } from './boot.js';
import { start } from '@reticlehq/server';

vi.mock('@reticlehq/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@reticlehq/server')>();
  return { ...actual, start: vi.fn() };
});

/** Hold a port with a plain TCP server: FOREIGN — accepts TCP, answers no /status. */
async function holdTcpPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Serve a fake Reticle /status: DAEMON — the probe classifies the port as daemon-owned. */
async function holdDaemonPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = createHttpServer((req, res) => {
    if ('/status' === req.url) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessionCount: 0, sessions: [] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('bootSession port conflicts', () => {
  it('rejects with a friendly error naming the port and the port option when start hits EADDRINUSE', async () => {
    const srv = createNetServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    const mockedStart = vi.mocked(start);
    mockedStart.mockRejectedValue(
      Object.assign(
        new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${String(port)}`),
        {
          code: 'EADDRINUSE',
        },
      ),
    );
    try {
      const err = await bootSession({ driveUrl: 'http://example.com/', port }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain(String(port));
      expect(message).toContain('port');
      expect(message).not.toContain('EADDRINUSE');
    } finally {
      mockedStart.mockReset();
      srv.close();
    }
  });

  it('refuses before starting when a Reticle daemon already owns the port', async () => {
    const held = await holdDaemonPort();
    const mockedStart = vi.mocked(start);
    try {
      const err = await bootSession({ driveUrl: 'http://example.com/', port: held.port }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain(String(held.port));
      expect(message).toContain('daemon');
      expect(message).toContain('port');
      expect(message).toContain('reticle stop');
      expect(mockedStart).not.toHaveBeenCalled();
    } finally {
      mockedStart.mockReset();
      await held.close();
    }
  });

  it('starts normally when the port is free', async () => {
    const held = await holdTcpPort();
    const freePort = held.port;
    await held.close();
    const mockedStart = vi.mocked(start);
    const fakeServer = { close: () => Promise.resolve() } as never;
    mockedStart.mockResolvedValue(fakeServer);
    const fakeDeps = { sessions: {} } as never;
    try {
      // Should reach start(): the probe sees a free port and does not refuse.
      await bootSession({
        driveUrl: 'http://example.com/',
        port: freePort,
        buildDeps: () => fakeDeps,
      }).catch(() => undefined);
      expect(mockedStart).toHaveBeenCalled();
    } finally {
      mockedStart.mockReset();
    }
  });
});
