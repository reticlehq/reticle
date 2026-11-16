/**
 * Any HTTP service answering JSON on `/status` used to count as a Reticle daemon.
 *
 * An unrelated MCP server on the port init had chosen answered `/status` with JSON of its own. It was
 * adopted as the daemon, the page's bridge dial got WebSocket 404s, and init blamed the dev server.
 * Only a body in the shape every Reticle daemon sends is a daemon; anything else is a stranger, which
 * `probePresence` reports as FOREIGN and init refuses in words.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchStatus } from './daemon-status-probe.js';
import { PortPresence, probePresence } from './port-presence.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const paths: string[] = [];
function serve(body: unknown): Promise<number> {
  server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const s = server;
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (null === addr || 'string' === typeof addr) reject(new Error('no port'));
      else resolve(addr.port);
    });
  });
}

const tcpOpen = (): Promise<boolean> => Promise.resolve(true);

describe('what counts as a Reticle daemon on /status', () => {
  it('is not any JSON: a stranger answering /status is FOREIGN', async () => {
    const port = await serve({ status: 'ok', name: 'some-mcp-server', version: '1.0.0' });
    expect(await fetchStatus(port)).toBeUndefined();
    expect(await probePresence(port, { tcpOpen, status: fetchStatus })).toBe(PortPresence.FOREIGN);
  });

  it('is the body a Reticle daemon sends', async () => {
    const body = {
      running: true,
      version: '3.3.0',
      contract: 'abc',
      sessionCount: 0,
      sessions: [],
    };
    const port = await serve(body);
    expect(await fetchStatus(port)).toEqual(body);
    expect(await probePresence(port, { tcpOpen, status: fetchStatus })).toBe(PortPresence.DAEMON);
  });

  it('includes a daemon too old to report a contract, so it can still be replaced as skewed', async () => {
    const port = await serve({ running: true, version: '2.14.0', sessionCount: 0, sessions: [] });
    expect(await fetchStatus(port)).toBeDefined();
  });
});

/**
 * Reported from the field: on Windows, an agent's MCP proxy refused the user's own daemon as "a port
 * held by another process". The daemon was the same version and running, but `/status` did not
 * answer in time, or the request went out on a pooled keep-alive socket the daemon had already
 * closed. Either way the port read FOREIGN, the wake was refused, and the agent got no tool. A
 * failed probe now asks once more, on a fresh socket with a longer limit, before calling the port
 * a stranger's. A body that is not a daemon's is still FOREIGN at once.
 */
describe('a daemon that is slow or behind a stale socket is still a daemon', () => {
  const DAEMON = { running: true, version: '3.10.4', sessionCount: 0, sessions: [] };
  const SLOWER_THAN_FIRST_LIMIT_MS = 1500;

  function listen(s: Server): Promise<number> {
    server = s;
    return new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        if (null === addr || 'string' === typeof addr) {
          reject(new Error('no port'));
        } else {
          resolve(addr.port);
        }
      });
    });
  }

  it('reads a daemon that answers after the first limit as a daemon', async () => {
    const port = await listen(
      createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(DAEMON));
        }, SLOWER_THAN_FIRST_LIMIT_MS);
      }),
    );
    expect(await probePresence(port, { tcpOpen, status: fetchStatus })).toBe(PortPresence.DAEMON);
  }, 20_000);

  it('reads a daemon whose first connection is reset as a daemon', async () => {
    let requests = 0;
    const port = await listen(
      createServer((req, res) => {
        requests += 1;
        if (1 === requests) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(DAEMON));
      }),
    );
    expect(await probePresence(port, { tcpOpen, status: fetchStatus })).toBe(PortPresence.DAEMON);
    expect(requests).toBe(2);
  }, 20_000);

  it('does not ask again when the port answered with a body that is not a daemon', async () => {
    let requests = 0;
    const port = await listen(
      createServer((_req, res) => {
        requests += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', name: 'some-mcp-server' }));
      }),
    );
    expect(await probePresence(port, { tcpOpen, status: fetchStatus })).toBe(PortPresence.FOREIGN);
    expect(requests).toBe(1);
  }, 20_000);
});

describe('holding the daemon', () => {
  it('asks /status with the hold flag only when told to', async () => {
    const port = await serve({ running: true, version: '3.3.0', sessions: [] });
    paths.length = 0;
    await fetchStatus(port);
    await fetchStatus(port, '127.0.0.1', true);
    expect(paths).toEqual(['/status', '/status?hold=1']);
  });
});
