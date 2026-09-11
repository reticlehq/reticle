import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  statSync,
  renameSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnDaemon, type SpawnDaemonDeps, type SpawnedChild } from './daemon/daemon.js';

describe('spawnDaemon with injectable deps', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'reticle-spawn-test-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function makeDeps(overrides?: Partial<SpawnDaemonDeps>): {
    deps: SpawnDaemonDeps;
    opened: Array<{ path: string; flags: string; fd: number }>;
    closed: number[];
    wasSpawned(): boolean;
  } {
    const opened: Array<{ path: string; flags: string; fd: number }> = [];
    const closed: number[] = [];
    let spawned = false;

    const deps: SpawnDaemonDeps = {
      home,
      openFile: (path, flags) => {
        const fd = openSync(path, flags);
        opened.push({ path, flags, fd });
        return fd;
      },
      fileSize: (path) => (existsSync(path) ? statSync(path).size : 0),
      renameFile: renameSync,
      closeFile: (fd) => {
        closed.push(fd);
        closeSync(fd);
      },
      spawnChild: () => {
        spawned = true;
        return { pid: 12345, on: () => undefined, unref: () => undefined };
      },
      pidAlive: () => false,
      ...overrides,
    };

    return { deps, opened, closed, wasSpawned: () => spawned };
  }

  it('spawns successfully and writes the pid to the pidfile', () => {
    const harness = makeDeps();
    const ok = spawnDaemon('node', 'script.mjs', ['--port', '4000'], 4000, harness.deps);

    expect(ok).toBe(true);
    expect(harness.wasSpawned()).toBe(true);
    const pidFile = join(home, 'daemon-4000.pid');
    expect(existsSync(pidFile)).toBe(true);
    expect(readFileSync(pidFile, 'utf8')).toBe('12345');
  });

  it('closes the log fd in the parent after spawn', () => {
    const { deps, opened, closed } = makeDeps();
    spawnDaemon('node', 'script.mjs', [], 4001, deps);

    const logEntry = opened.find((e) => 'a' === e.flags);
    expect(logEntry).toBeDefined();
    expect(closed).toContain(logEntry?.fd);
  });

  it('closes the lock fd after writing the pid', () => {
    const { deps, opened, closed } = makeDeps();
    spawnDaemon('node', 'script.mjs', [], 4002, deps);

    const lockEntry = opened.find((e) => 'wx' === e.flags);
    expect(lockEntry).toBeDefined();
    expect(closed).toContain(lockEntry?.fd);
  });

  it('returns false and cleans up when openFile(log) throws', () => {
    const realOpened: Array<{ path: string; flags: string; fd: number }> = [];
    let callCount = 0;
    const { deps, closed } = makeDeps({
      openFile: (path, flags) => {
        callCount += 1;
        if (2 === callCount) throw new Error('disk full');
        const fd = openSync(path, flags);
        realOpened.push({ path, flags, fd });
        return fd;
      },
    });

    const ok = spawnDaemon('node', 'script.mjs', [], 4003, deps);

    expect(ok).toBe(false);
    expect(realOpened.length).toBe(1);
    expect(closed).toContain(realOpened[0]?.fd);
    expect(existsSync(join(home, 'daemon-4003.pid'))).toBe(false);
  });

  it('returns false and cleans up when spawnChild throws', () => {
    const { deps, opened, closed } = makeDeps({
      spawnChild: () => {
        throw new Error('ENOMEM');
      },
    });

    const ok = spawnDaemon('node', 'script.mjs', [], 4004, deps);

    expect(ok).toBe(false);
    const lockEntry = opened.find((e) => 'wx' === e.flags);
    const logEntry = opened.find((e) => 'a' === e.flags);
    expect(lockEntry).toBeDefined();
    expect(logEntry).toBeDefined();
    expect(closed).toContain(lockEntry?.fd);
    expect(closed).toContain(logEntry?.fd);
    expect(existsSync(join(home, 'daemon-4004.pid'))).toBe(false);
  });

  it('returns false and cleans up when child.pid is undefined', () => {
    const undefinedPidChild: SpawnedChild = {
      pid: undefined,
      on: () => undefined,
      unref: () => undefined,
    };
    const { deps, opened, closed } = makeDeps({
      spawnChild: () => undefinedPidChild,
    });

    const ok = spawnDaemon('node', 'script.mjs', [], 4005, deps);

    expect(ok).toBe(false);
    const lockEntry = opened.find((e) => 'wx' === e.flags);
    const logEntry = opened.find((e) => 'a' === e.flags);
    expect(closed).toContain(lockEntry?.fd);
    expect(closed).toContain(logEntry?.fd);
    expect(existsSync(join(home, 'daemon-4005.pid'))).toBe(false);
  });

  it('returns false without spawning when a live daemon owns the port', () => {
    let spawned = false;
    const { deps } = makeDeps({
      pidAlive: () => true,
      spawnChild: () => {
        spawned = true;
        return { pid: 12345, on: () => undefined, unref: () => undefined };
      },
    });
    const pidFile = join(home, 'daemon-4006.pid');
    writeFileSync(pidFile, '99999', 'utf8');

    const ok = spawnDaemon('node', 'script.mjs', [], 4006, deps);

    expect(ok).toBe(false);
    expect(spawned).toBe(false);
  });

  it('reclaims a stale pidfile and spawns successfully', () => {
    const pidFile = join(home, 'daemon-4007.pid');
    writeFileSync(pidFile, '11111', 'utf8');

    const { deps } = makeDeps({ pidAlive: () => false });
    const ok = spawnDaemon('node', 'script.mjs', [], 4007, deps);

    expect(ok).toBe(true);
    expect(readFileSync(pidFile, 'utf8')).toBe('12345');
  });
});
