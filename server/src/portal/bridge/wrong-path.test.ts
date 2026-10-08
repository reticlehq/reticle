/**
 * A dial on the wrong path is remembered and named (#1242).
 *
 * `ws` answers an upgrade on any path but the bridge's with a bare 400, before `verifyClient` runs,
 * so it left no trace and the no-session diagnosis could not name the one cause that applied.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { RETICLE_WS_PATH } from '@reticlehq/core';
import { Bridge } from './bridge.js';
import { requestedPath } from './wrong-path.js';

const bridges: Bridge[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(
    servers.splice(0).map((srv) => new Promise<void>((resolve) => srv.close(() => resolve()))),
  );
});

function dial(port: number, path: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${path}`, {
      origin: 'http://localhost:5173',
    });
    socket.once('error', () => resolve());
    socket.once('open', () => {
      socket.terminate();
      resolve();
    });
  });
}

describe('a dial on the wrong bridge path', () => {
  it('is recorded with the path it used and the one it needed, and never the query', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const port = await bridge.ready;

    await dial(port, '/ws?token=pairing-secret-123');

    const reason = bridge.sessions.lastClosure()?.reason ?? '';
    expect(reason).toContain('asked for /ws ');
    expect(reason).toContain(`listens on ${RETICLE_WS_PATH} only`);
    expect(reason).toContain('http://localhost:5173');
    expect(reason).not.toContain('pairing-secret-123');
    // Answered before any origin check, so it is not proof the user's app is running.
    expect(reason).toContain('If that was your app');
    expect(reason).not.toMatch(/stopped dev server|is running/);
  });

  it('reaches the agent through the no-session error', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const port = await bridge.ready;

    await dial(port, '/socket');

    expect(() => bridge.sessions.resolve()).toThrow(/asked for \/socket and got a 400/);
  });

  it('is recorded on a bridge sharing the daemon HTTP server too', async () => {
    const srv = http.createServer();
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const bridge = new Bridge({ port: 0, server: srv });
    bridges.push(bridge);
    await bridge.ready;

    await dial((srv.address() as AddressInfo).port, '/ws');

    expect(bridge.sessions.lastClosure()?.reason ?? '').toContain('asked for /ws ');
  });

  it('records nothing for a dial on the bridge path', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const port = await bridge.ready;

    await dial(port, RETICLE_WS_PATH);

    expect(bridge.sessions.lastClosure()).toBeUndefined();
  });
});

describe('requestedPath', () => {
  it('keeps the pathname, drops the query, and caps a junk path', () => {
    expect(requestedPath('/ws?token=x')).toBe('/ws');
    expect(requestedPath(undefined)).toBe('/');
    expect(requestedPath(`/${'a'.repeat(200)}`)).toHaveLength(81);
  });
});
