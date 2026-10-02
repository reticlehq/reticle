/**
 * `localhost` must reach the daemon on every platform.
 *
 * The daemon binds IPv4 loopback. The SDK's default bridge URL says `localhost`. On Windows, Chrome
 * resolves `localhost` to `::1` FIRST — so the default configuration cannot connect on the platform's
 * default browser, and the failure surfaces as "is the daemon running on that port?" while the daemon
 * is demonstrably running on that port. Every remedy that message suggests (container, devcontainer,
 * WSL) is wrong for a plain Windows user, so the reader does not see themselves in it at all.
 *
 * Fixing this in the SDK's default URL would only help apps that reinstall. Aliasing the other
 * loopback address on the daemon side fixes the installs that already exist, on their next start,
 * with no app change — which is the point.
 *
 * NOT covered here, deliberately: that closing the alias ends its connections rather than draining
 * them. Adding the alias made the daemon ignore SIGTERM — `server.close()` fires its callback only
 * once every connection has gone, the daemon serves keep-alive and SSE, and the shutdown chain
 * awaits that close — so `reticle stop` timed out and the process stayed alive with the port held.
 * The guard for it is `apps/e2e/specs/daemon-heartbeat-test.mjs`, which is what caught it: it starts
 * a real daemon and watches it actually die. A unit-level version of that assertion passed
 * identically with and without the fix, and a test that cannot fail is worse than no test, so it is
 * not here pretending to guard something.
 */

import { describe, expect, it, afterEach } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { openLoopbackAlias, IPV6_LOOPBACK } from './loopback-alias.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

/** True when this machine can bind `::1` at all — a CI runner with IPv6 disabled cannot. */
async function hasIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, IPV6_LOOPBACK, () => probe.close(() => resolve(true)));
  });
}

/** A one-route HTTP server on IPv4 loopback, standing in for the daemon. */
async function startOrigin(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('daemon');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = 'object' === typeof address && null !== address ? address.port : 0;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('loopback alias', () => {
  it('serves the IPv4 daemon over ::1, so `localhost` resolves either way', async ({ skip }) => {
    if (!(await hasIpv6Loopback())) skip();
    const origin = await startOrigin();
    cleanups.push(origin.close);
    const alias = await openLoopbackAlias(origin.port);
    cleanups.push(alias.close);
    expect(alias.opened).toBe(true);

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: IPV6_LOOPBACK, port: origin.port, family: 6 }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += String(chunk)));
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
    });
    expect(body).toBe('daemon');
  });

  it('reports failure instead of throwing when ::1 cannot be bound', async () => {
    const origin = await startOrigin();
    cleanups.push(origin.close);
    const blocker = net.createServer();
    const bound = await new Promise<boolean>((resolve) => {
      blocker.once('error', () => resolve(false));
      blocker.listen(origin.port, IPV6_LOOPBACK, () => resolve(true));
    });
    if (!bound) {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      return;
    }
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

    const alias = await openLoopbackAlias(origin.port);
    cleanups.push(alias.close);
    expect(alias.opened).toBe(false);
  });

  it('closing the alias is safe even when it never opened', async () => {
    const alias = await openLoopbackAlias(1);
    await expect(alias.close()).resolves.toBeUndefined();
  });
});
