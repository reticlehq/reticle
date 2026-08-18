import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { probeDevServers } from './dev-server-probe.js';

const servers: Server[] = [];

/** A dev-server stand-in on `host`, answering `/` with a document after `delayMs`. */
async function serve(port: number, host: string, delayMs = 0): Promise<void> {
  const server = createServer((_req, res) => {
    const answer = (): void => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>app</title>');
    };
    if (0 === delayMs) answer();
    else setTimeout(answer, delayMs);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('dev server probe', () => {
  it('finds a server bound to the IPv4 wildcard', async () => {
    // The reported case: `--host` binds 0.0.0.0 rather than 127.0.0.1, and the user was told
    // nothing was listening. Probing `localhost` covers this, because Node tries both address
    // families — this test is here so that a future switch back to a pinned address fails loudly.
    await serve(45011, '0.0.0.0');

    await expect(probeDevServers([45011])).resolves.toEqual([45011]);
  });

  it('finds a server bound to the IPv6 wildcard', async () => {
    await serve(45012, '::');

    await expect(probeDevServers([45012])).resolves.toEqual([45012]);
  });

  it('finds a server bound to the IPv4 loopback only', async () => {
    await serve(45013, '127.0.0.1');

    await expect(probeDevServers([45013])).resolves.toEqual([45013]);
  });

  it('reports nothing on a port with no listener', async () => {
    await expect(probeDevServers([45014])).resolves.toEqual([]);
  });

  it('finds a dev server that is slow to answer its first request', async () => {
    // A dev server compiling on first hit does not answer in a few hundred milliseconds. The old
    // 400ms budget gave up on it and the message then said nothing was listening — the same
    // conclusion as an empty port, from evidence that is nothing like it.
    await serve(45015, '0.0.0.0', 900);

    await expect(probeDevServers([45015])).resolves.toEqual([45015]);
  }, 10_000);

  it('returns found ports in ascending order', async () => {
    await serve(45017, '0.0.0.0');
    await serve(45016, '0.0.0.0');

    await expect(probeDevServers([45017, 45016])).resolves.toEqual([45016, 45017]);
  });
});
