import { describe, expect, it } from 'vitest';
import { join, sep } from 'node:path';
import type { Checkout, DevServerEntry } from '@reticlehq/core';
import {
  liveCheckoutSource,
  listenerFolders,
  MAX_FOLDER_LOOKUPS,
  servingDirectoryOf,
} from './serving-directory.js';

const MAIN = join(sep, 'repo', 'main');
const CLONE = join(sep, 'repo', 'clone');

/**
 * Which checkout served a page, for the case where every git worktree declares one projectId. The
 * announced dev server is exact and works everywhere; the listener's cwd covers frameworks with no
 * announcing plugin. Both are injected here, so these specs start no processes.
 */
describe('servingDirectoryOf', () => {
  const entry = (port: number, root: string): DevServerEntry => ({
    port,
    pid: 1,
    root,
    url: `http://localhost:${String(port)}`,
    startedAt: 0,
  });

  it('prefers the dev server that announced this port', () => {
    let shelledOut = false;
    const dir = servingDirectoryOf('http://localhost:5174', {
      devServers: () => [entry(5173, MAIN), entry(5174, CLONE)],
      listenerCwd: () => {
        shelledOut = true;
        return MAIN;
      },
    });

    expect(dir).toBe(CLONE);
    expect(shelledOut).toBe(false);
  });

  /**
   * A dev proxy (portless) serves every worktree on port 443 under its own name, and the dev server
   * behind it listens on another port. The port cannot tell the worktrees apart; the announced URL can.
   */
  it('matches a dev server by the URL it announced, before the port', () => {
    const behindProxy = (port: number, root: string, url: string): DevServerEntry => ({
      ...entry(port, root),
      url,
    });
    const dir = servingDirectoryOf('https://feat-x.app.localhost', {
      devServers: () => [
        behindProxy(4101, MAIN, 'https://app.localhost'),
        behindProxy(4102, CLONE, 'https://feat-x.app.localhost'),
      ],
      listenerCwd: () => MAIN,
    });

    expect(dir).toBe(CLONE);
  });

  /**
   * A dev server with no announcing plugin (Next.js) behind portless. The page's port is the proxy's,
   * and `lsof` on it gave the proxy's own folder, so every such tab was placed in one checkout.
   * portless's route table names the port of the dev server behind each name.
   */
  it('follows a dev proxy route to the dev server behind it', () => {
    const ports: number[] = [];
    const dir = servingDirectoryOf('http://feat-x.app.localhost:1355', {
      devServers: () => [],
      listenerCwd: (port) => {
        ports.push(port);
        return 4102 === port ? CLONE : MAIN;
      },
      devProxy: () => ({
        ports: [1355],
        routes: [{ hostname: 'feat-x.app.localhost', port: 4102 }],
      }),
    });

    expect(dir).toBe(CLONE);
    expect(ports).toEqual([4102]);
  });

  it('places no page on the proxy port that no route names', () => {
    const dir = servingDirectoryOf('http://gone.app.localhost:1355', {
      devServers: () => [],
      listenerCwd: () => MAIN,
      devProxy: () => ({ ports: [1355], routes: [] }),
    });

    expect(dir).toBeUndefined();
  });

  it('falls back to the working directory of whatever listens on the port', () => {
    const ports: number[] = [];
    const dir = servingDirectoryOf('http://127.0.0.1:3001', {
      devServers: () => [],
      listenerCwd: (port) => {
        ports.push(port);
        return CLONE;
      },
    });

    expect(dir).toBe(CLONE);
    expect(ports).toEqual([3001]);
  });

  it('reads the default port when the origin names none', () => {
    const ports: number[] = [];
    servingDirectoryOf('http://localhost', {
      devServers: () => [],
      listenerCwd: (port) => {
        ports.push(port);
        return null;
      },
    });

    expect(ports).toEqual([80]);
  });

  /** A remote page's port says nothing about a process on this machine. */
  it('answers nothing for a page that is not served from this machine', () => {
    let consulted = false;
    const io = {
      devServers: () => {
        consulted = true;
        return [entry(443, CLONE)];
      },
      listenerCwd: () => {
        consulted = true;
        return CLONE;
      },
    };

    expect(servingDirectoryOf('https://staging.example.com', io)).toBeUndefined();
    expect(servingDirectoryOf('not a url', io)).toBeUndefined();
    expect(consulted).toBe(false);
  });
});

describe('liveCheckoutSource', () => {
  const at = (root: string): Checkout => ({ root, mainRoot: MAIN, commonDir: MAIN, linked: true });

  /**
   * Worktree A's dev server stops and worktree B's starts on the same port. The page reloads, which is
   * a new connection, and it now runs B's code. A cache by origin named it A's for 30 seconds, so the
   * agent in A drove B's code and the agent in B was refused.
   */
  it('places each tab connection once, and a reloaded tab again', () => {
    let served = at(MAIN);
    let lookups = 0;
    const source = liveCheckoutSource(() => {
      lookups += 1;
      return served;
    });
    const first = { id: 's', url: 'http://localhost:5173/' };

    expect(source.ofTab(first)?.root).toBe(MAIN);
    served = at(CLONE);
    expect(source.ofTab(first)?.root).toBe(MAIN);
    expect(source.ofTab({ id: 's', url: 'http://localhost:5173/' })?.root).toBe(CLONE);
    expect(lookups).toBe(2);
  });
});

/**
 * The folder of each listener. One lookup runs `lsof` twice and blocks the daemon, and this runs on
 * every scan, so a port is asked about once while it stays open.
 */
describe('listenerFolders', () => {
  it('asks about a port once while it stays open', () => {
    const asked: number[] = [];
    const lookup = (port: number): string | undefined => {
      asked.push(port);
      return 3000 === port ? MAIN : undefined;
    };
    const first = listenerFolders([3000, 3001], new Map(), lookup);
    const second = listenerFolders([3000, 3001], first, lookup);
    expect(asked).toEqual([3000, 3001]);
    expect(second.get(3000)).toBe(MAIN);
  });

  it('forgets a port that closed, so the next process on it is asked about', () => {
    const first = listenerFolders([3000], new Map(), () => MAIN);
    const closed = listenerFolders([], first, () => MAIN);
    expect(listenerFolders([3000], closed, () => CLONE).get(3000)).toBe(CLONE);
  });

  it('bounds one scan, and the next scan asks about the rest', () => {
    const ports = Array.from({ length: MAX_FOLDER_LOOKUPS + 1 }, (_, index) => 3000 + index);
    let asked = 0;
    const lookup = (): string => {
      asked += 1;
      return MAIN;
    };
    const first = listenerFolders(ports, new Map(), lookup);
    expect(asked).toBe(MAX_FOLDER_LOOKUPS);
    expect(listenerFolders(ports, first, lookup).size).toBe(ports.length);
  });
});
