/**
 * Sync requests time out.
 *
 * Incident: the sync daemon and `reticle sync` called a bare `fetch`. One connection that was accepted
 * and never answered left the daemon's cycle "running" forever, so every later cycle returned at
 * once and the dashboard stopped updating with nothing in the log to say why.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { syncRequest } from './cloud-sync.js';

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

describe('a sync request', () => {
  it('gives up on a server that accepts the connection and never answers', async () => {
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await expect(
      syncRequest(
        `http://127.0.0.1:${String(port)}/v1/sync/status`,
        { method: 'GET', headers: {} },
        200,
      ),
    ).rejects.toThrow(/timed out/);
  });

  it('returns the status and body of a server that answers', async () => {
    server = createServer((_req, res) => res.end('{"ok":true}'));
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const answer = await syncRequest(`http://127.0.0.1:${String(port)}/v1/sync/status`, {
      method: 'GET',
      headers: {},
    });
    expect(answer).toEqual({ status: 200, text: '{"ok":true}' });
  });
});
