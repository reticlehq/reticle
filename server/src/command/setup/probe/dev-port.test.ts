/**
 * The dev port is asked before the dev server is started (#1377).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { Framework } from '@reticlehq/init';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expectedDevPort,
  loneLoopbackOnDevPort,
  pinnedDevPort,
  splitDevPortNote,
} from './dev-port.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

function listen(host: string, port = 0): Promise<number | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(undefined));
    server.listen({ port, host, ipv6Only: true }, () => {
      servers.push(server);
      const address = server.address();
      resolve(null !== address && 'object' === typeof address ? address.port : undefined);
    });
  });
}

describe('expectedDevPort', () => {
  it('takes the port the script pins, over any default', () => {
    expect(expectedDevPort({ pinned: 4000, framework: Framework.VITE })).toBe(4000);
  });

  it("falls back to the framework's default", () => {
    expect(expectedDevPort({ framework: Framework.VITE })).toBe(5173);
    expect(expectedDevPort({ framework: Framework.NEXT })).toBe(3000);
  });

  it('guesses nothing when the dev config may move the port, or the framework is unknown', () => {
    expect(
      expectedDevPort({ framework: Framework.VITE, devConfig: 'server: { port: 8080 }' }),
    ).toBeUndefined();
    expect(expectedDevPort({ framework: Framework.HTML })).toBeUndefined();
    expect(expectedDevPort({})).toBeUndefined();
  });
});

describe('loneLoopbackOnDevPort', () => {
  it('names the loopback something answers on while the other is free', async () => {
    const port = await listen('127.0.0.1');
    expect(port).toBeDefined();
    expect(await loneLoopbackOnDevPort(port ?? 0)).toBe('127.0.0.1');
  });

  it('finds a server that holds only ::1, the case that looked like a flaky connect', async () => {
    const port = await listen('::1');
    if (port === undefined) return; // no IPv6 loopback on this machine
    expect(await loneLoopbackOnDevPort(port)).toBe('::1');
  });

  it('says nothing about a port busy on both loopbacks: the dev server sees it and moves', async () => {
    const port = await listen('127.0.0.1');
    expect(port).toBeDefined();
    if (undefined === (await listen('::1', port))) return; // no IPv6 loopback on this machine
    expect(await loneLoopbackOnDevPort(port ?? 0)).toBeUndefined();
  });

  it('says nothing about a free port', async () => {
    const port = await listen('127.0.0.1');
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    expect(await loneLoopbackOnDevPort(port ?? 0)).toBeUndefined();
  });
});

describe('splitDevPortNote', () => {
  it('names the held half, the free half, and how to attach instead', () => {
    const note = splitDevPortNote(5173, '127.0.0.1');
    expect(note).toContain('127.0.0.1:5173');
    expect(note).toContain('[::1]:5173');
    expect(note).toContain('--url http://localhost:5173');
  });
});

describe('pinnedDevPort', () => {
  const appWith = (scripts: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-port-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
    return dir;
  };

  it('reads --port, -p and PORT= from the dev script', () => {
    expect(pinnedDevPort(appWith({ dev: 'vite --port 4000' }))).toBe(4000);
    expect(pinnedDevPort(appWith({ dev: 'next dev -p 3100' }))).toBe(3100);
    expect(pinnedDevPort(appWith({ start: 'PORT=8081 react-scripts start' }))).toBe(8081);
  });

  it('is undefined for a script that pins nothing, or no package.json', () => {
    expect(pinnedDevPort(appWith({ dev: 'vite' }))).toBeUndefined();
    expect(pinnedDevPort(mkdtempSync(join(tmpdir(), 'dev-port-')))).toBeUndefined();
  });
});
