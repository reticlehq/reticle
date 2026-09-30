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

describe('holding the daemon', () => {
  it('asks /status with the hold flag only when told to', async () => {
    const port = await serve({ running: true, version: '3.3.0', sessions: [] });
    paths.length = 0;
    await fetchStatus(port);
    await fetchStatus(port, '127.0.0.1', true);
    expect(paths).toEqual(['/status', '/status?hold=1']);
  });
});
