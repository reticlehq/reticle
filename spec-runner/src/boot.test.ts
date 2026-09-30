import { createServer } from 'node:net';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { ReticleEnv, STATUS_PATH } from '@reticlehq/core';
import type { RunningServer } from '@reticlehq/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootSession } from './boot.js';

/**
 * Every holder fixture in this file listens on `127.0.0.1` (Node's own `LOOPBACK_HOST` default), but
 * `bootSession` resolves its probe host from `RETICLE_HOST` when that's set (reticlehq/reticle#1165
 * review, "Probe checks wrong host"). A `RETICLE_HOST` left over in the environment — `::1`, say —
 * would make every test below probe an address nothing is listening on, so `bootSession` would see
 * FREE and sail past the refusal these tests exist to check, failing for a reason that has nothing to
 * do with the code under test (reticlehq/reticle#1165 review, "Holder tests depend on environment").
 */
let savedReticleHost: string | undefined;

beforeEach(() => {
  savedReticleHost = process.env[ReticleEnv.HOST];
  delete process.env[ReticleEnv.HOST];
});

afterEach(() => {
  if (savedReticleHost === undefined) {
    delete process.env[ReticleEnv.HOST];
  } else {
    process.env[ReticleEnv.HOST] = savedReticleHost;
  }
});

/**
 * reticlehq/reticle#1141: `bootSession()` called `start()` with no pre-flight port check, so on a
 * machine where something already holds the port it rejected with the raw `node:net` EADDRINUSE
 * stack instead of a message anyone could act on.
 */
describe('bootSession against a port that is already taken', () => {
  let holder: ReturnType<typeof createServer> | undefined;
  // The port probe (and a raw connect from a caller that ignored the refusal) leaves its socket
  // open against this server, which is never read from and never ends it — so a plain `close()`
  // would hang the hook waiting for a connection nobody was ever going to close.
  let connections: Socket[] = [];

  afterEach(async () => {
    if (holder === undefined) return;
    connections.forEach((socket) => socket.destroy());
    connections = [];
    await new Promise<void>((resolve) => holder?.close(() => resolve()));
    holder = undefined;
  });

  it('rejects with an Error naming the port and the `port` option, not a raw EADDRINUSE', async () => {
    holder = createServer((socket) => connections.push(socket));
    const port = await new Promise<number>((resolve, reject) => {
      holder?.once('error', reject);
      holder?.listen(0, '127.0.0.1', () => {
        resolve((holder?.address() as AddressInfo).port);
      });
    });

    let caught: unknown;
    try {
      await bootSession({ driveUrl: 'http://localhost:5173', port });
      expect.unreachable('bootSession should have rejected against an already-taken port');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message, 'names the port').toContain(String(port));
    expect(message.toLowerCase(), 'names the option').toContain('port');
    expect(message, 'never a bare node error').not.toMatch(/EADDRINUSE|node:net/);
    // reticlehq/reticle#1165 review, "Stop advice misidentifies holder": a stranger process holds
    // this port, and `reticle stop` cannot touch it — only a different `port` gets bootSession going.
    expect(
      message,
      'does not send the caller after a process reticle stop cannot reach',
    ).not.toMatch(/reticle stop/);
  });
});

/**
 * reticlehq/reticle#1165 review: the maintainer's requested-changes noted the issue's own leading
 * case — a Reticle daemon already sitting on the port — had no test, unlike the generic-stranger
 * case above. A real daemon answers `STATUS_PATH`, which is what tells `probePresence` DAEMON
 * from FOREIGN; a plain TCP holder (the test above) can only ever produce FOREIGN.
 */
describe('bootSession against a port a Reticle daemon already owns', () => {
  let daemon: http.Server | undefined;

  afterEach(async () => {
    if (daemon === undefined) return;
    await new Promise<void>((resolve) => daemon?.close(() => resolve()));
    daemon = undefined;
  });

  it('rejects with an Error naming both `port` and `reticle stop`', async () => {
    daemon = http.createServer((req, res) => {
      if ('GET' === req.method && (req.url ?? '').startsWith(STATUS_PATH)) {
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ running: true, version: '0.0.0', sessions: [] }));
        return;
      }
      res.writeHead(404).end();
    });
    const port = await new Promise<number>((resolve, reject) => {
      daemon?.once('error', reject);
      daemon?.listen(0, '127.0.0.1', () => {
        resolve((daemon?.address() as AddressInfo).port);
      });
    });

    let caught: unknown;
    try {
      await bootSession({ driveUrl: 'http://localhost:5173', port });
      expect.unreachable('bootSession should have rejected against a daemon-held port');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message, 'names the port').toContain(String(port));
    // Only a Reticle daemon can actually be freed by `reticle stop` — this is the one presence the
    // advice is correct for (reticlehq/reticle#1165 review, "Stop advice misidentifies holder").
    expect(message, 'offers reticle stop, the remedy that actually applies to a daemon').toMatch(
      /reticle stop/,
    );
    expect(message, 'still names the `port` option too').toMatch(/`port`/);
    // reticlehq/reticle#1165 review's exact complaint: describePresence's DAEMON fragment has no
    // trailing period, so a naive concatenation read "…serving :4400 Pass a different…" — one
    // run-on sentence with no break where the reader needs one.
    expect(message, 'closes the daemon sentence before the next one starts').toContain(
      `:${String(port)}. Pass`,
    );
  });
});

/**
 * reticlehq/reticle#1165 review, "Readiness failure lacks test coverage": the two describe blocks
 * above only ever exercise the *preflight* refusal — probePresence catching a port that was already
 * occupied before bootSession was called. Neither can reach the `bridge.ready` catch block added for
 * the bind-race gap (reticlehq/reticle#1165 review, "Bind race escapes catch"), so a regression there
 * — an unhandled rejection, or a leaked browser/server from skipping `server.close()` — could ship
 * with every test above still green. Winning a real race against `start()`'s own bind isn't a
 * reliable way to drive that path (CLAUDE.md already treats a timing-dependent test as a bug in the
 * test), so `BootOptions.startServer` exists purely to let this be driven directly instead.
 */
describe("bootSession when the server's bind fails after start() has already resolved", () => {
  async function freePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
  }

  function fakeStartedServer(readyRejection: Error): {
    startServer: () => Promise<RunningServer>;
    wasClosed: () => boolean;
  } {
    let closed = false;
    // Rejects immediately -- caught below before bootSession ever awaits it, so nothing here can
    // surface as an unhandled rejection in the test process.
    const ready = Promise.reject(readyRejection);
    ready.catch(() => undefined);
    const server = {
      bridge: { ready },
      close: (): Promise<void> => {
        closed = true;
        return Promise.resolve();
      },
    } as unknown as RunningServer;
    return {
      startServer: (): Promise<RunningServer> => Promise.resolve(server),
      wasClosed: () => closed,
    };
  }

  it('translates a lost bind race into the same refusal a preflight-taken port gets, and closes the server first', async () => {
    const eaddrinuse = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
      code: 'EADDRINUSE',
    });
    const { startServer, wasClosed } = fakeStartedServer(eaddrinuse);
    const port = await freePort();

    let caught: unknown;
    try {
      await bootSession({ driveUrl: 'http://localhost:5173', port, startServer });
      expect.unreachable('bootSession should have rejected when bridge.ready lost the race');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message, 'names the port').toContain(String(port));
    expect(message, 'never the bare node error it actually caught').not.toMatch(
      /EADDRINUSE|node:net/,
    );
    expect(wasClosed(), 'closes the server that had already started, before rethrowing').toBe(true);
  });

  it('passes an unrelated bridge.ready failure through unchanged, but still closes the server first', async () => {
    const original = new Error('something else entirely');
    const { startServer, wasClosed } = fakeStartedServer(original);
    const port = await freePort();

    let caught: unknown;
    try {
      await bootSession({ driveUrl: 'http://localhost:5173', port, startServer });
      expect.unreachable('bootSession should have rejected');
    } catch (error) {
      caught = error;
    }

    expect(caught, 'does not reinterpret a failure that was never a port conflict').toBe(original);
    expect(wasClosed(), 'closes the server before rethrowing an unrelated failure too').toBe(true);
  });
});
