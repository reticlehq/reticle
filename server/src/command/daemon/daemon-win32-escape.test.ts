/**
 * On Windows the daemon leaves the Job Object of the process that starts it.
 *
 * A child of `spawn(..., { detached: true })` stays in the job of its parent. When an agent host
 * runs `reticle mcp` in a job with KILL_ON_JOB_CLOSE, the close of that job killed the daemon too.
 * Shown on windows-latest by apps/e2e/win32-job-kill.mjs. A start through WMI survived every job.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonSpawnMethod, ReticleEnv } from '@reticlehq/core';
import { spawnDaemon, type SpawnDaemonDeps } from './daemon.js';
import type { EscapeRequest, EscapeResult } from './win32-escape.js';

const PORT = 4321;

describe('spawnDaemon leaves the job on Windows', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'reticle-escape-test-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function harness(
    platform: string,
    escape: (request: EscapeRequest) => EscapeResult,
  ): {
    deps: SpawnDaemonDeps;
    escapes: EscapeRequest[];
    spawnedEnv: () => Record<string, string | undefined> | undefined;
  } {
    const escapes: EscapeRequest[] = [];
    let spawnedEnv: Record<string, string | undefined> | undefined;
    const deps: SpawnDaemonDeps = {
      home,
      openFile: openSync,
      closeFile: closeSync,
      fileSize: (path) => (existsSync(path) ? statSync(path).size : 0),
      renameFile: renameSync,
      spawnChild: (_command, _args, options) => {
        spawnedEnv = options.env;
        return { pid: 12345, on: () => undefined, unref: () => undefined };
      },
      pidAlive: () => false,
      platform,
      escapeJob: (request) => {
        escapes.push(request);
        return escape(request);
      },
    };
    return { deps, escapes, spawnedEnv: () => spawnedEnv };
  }

  const pidFile = (): string => join(home, `daemon-${PORT}.pid`);

  it('starts the daemon through WMI on win32 and records the daemon pid', () => {
    const h = harness('win32', () => ({ launched: true, pid: 777 }));
    const ok = spawnDaemon('node', 'cli.js', ['_daemon', '--port', String(PORT)], PORT, h.deps);

    expect(ok).toBe(true);
    expect(h.spawnedEnv()).toBeUndefined();
    expect(readFileSync(pidFile(), 'utf8')).toBe('777');
    const request = h.escapes[0];
    expect(request?.command).toBe('node');
    expect(request?.args).toEqual(['cli.js', '_daemon', '--port', String(PORT)]);
    expect(request?.logPath).toBe(join(home, `daemon-${PORT}.log`));
    expect(request?.env[ReticleEnv.SPAWN_METHOD]).toBe(DaemonSpawnMethod.WMI);
  });

  it('falls back to the detached spawn when WMI launched nothing', () => {
    const h = harness('win32', () => ({ launched: false }));
    const ok = spawnDaemon('node', 'cli.js', [], PORT, h.deps);

    expect(ok).toBe(true);
    expect(readFileSync(pidFile(), 'utf8')).toBe('12345');
    expect(h.spawnedEnv()?.[ReticleEnv.SPAWN_METHOD]).toBe(DaemonSpawnMethod.WMI_FALLBACK);
  });

  it('falls back to the detached spawn when the WMI runner throws', () => {
    const h = harness('win32', () => {
      throw new Error('powershell missing');
    });
    expect(spawnDaemon('node', 'cli.js', [], PORT, h.deps)).toBe(true);
    expect(readFileSync(pidFile(), 'utf8')).toBe('12345');
    expect(h.spawnedEnv()?.[ReticleEnv.SPAWN_METHOD]).toBe(DaemonSpawnMethod.WMI_FALLBACK);
  });

  it('releases the lock when WMI launched a daemon but gave no pid', () => {
    const h = harness('win32', () => ({ launched: true }));
    expect(spawnDaemon('node', 'cli.js', [], PORT, h.deps)).toBe(true);
    expect(h.spawnedEnv()).toBeUndefined();
    expect(existsSync(pidFile())).toBe(false);
  });

  it('does not use WMI on other platforms', () => {
    const h = harness('linux', () => ({ launched: true, pid: 777 }));
    expect(spawnDaemon('node', 'cli.js', [], PORT, h.deps)).toBe(true);
    expect(h.escapes).toHaveLength(0);
    expect(readFileSync(pidFile(), 'utf8')).toBe('12345');
    expect(h.spawnedEnv()?.[ReticleEnv.SPAWN_METHOD]).toBe(DaemonSpawnMethod.DETACHED);
  });
});
