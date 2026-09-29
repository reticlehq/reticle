import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { bootSession } from './boot.js';

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
  });
});
