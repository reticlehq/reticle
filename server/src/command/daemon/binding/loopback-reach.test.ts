import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { isLocalhostSplit, probeLoopbackReach, type LoopbackReach } from './loopback-reach.js';

/** Listen on one address and hand back the port, so a probe has something real to answer about. */
async function listenOn(host: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const addr = server.address();
  if (null === addr || 'string' === typeof addr) throw new Error('no port');
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('which half of loopback answers', () => {
  it('reports v4 up and v6 down for an IPv4-only listener — the condition that hides the bridge', async () => {
    const srv = await listenOn('127.0.0.1');
    try {
      const reach = await probeLoopbackReach(srv.port);
      expect(reach.v4, 'the daemon binds 127.0.0.1, so this must answer').toBe(true);
      expect(reach.v6, 'nothing is forwarding [::1], which is what localhost picks first').toBe(
        false,
      );
      expect(isLocalhostSplit(reach)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('reports both down for a port nothing holds, and calls that no split', async () => {
    // Bind and release, so the port is real and free rather than a guess that might be in use.
    const srv = await listenOn('127.0.0.1');
    const { port } = srv;
    await srv.close();
    const reach = await probeLoopbackReach(port);
    expect(reach).toEqual({ v4: false, v6: false });
    // "Nothing is there" is already reported by every other check; naming a split here would send
    // a reader at IPv6 for a daemon that simply is not running.
    expect(isLocalhostSplit(reach)).toBe(false);
  });

  it('calls it no split once both halves answer', () => {
    const both: LoopbackReach = { v4: true, v6: true };
    expect(isLocalhostSplit(both)).toBe(false);
  });
});
