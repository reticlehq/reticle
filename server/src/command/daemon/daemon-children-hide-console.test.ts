/**
 * The daemon's own child processes hide their console window on Windows.
 *
 * The daemon runs detached, with no console. On Windows every console program it starts then gets
 * a new, visible console window. A user on 3.8.0 saw a terminal window flash every 15 seconds: the
 * daemon's PowerShell port lookup (`captureLookup`) ran with no `windowsHide`. The git lookups the
 * daemon runs had the same gap. `windowsHide` does nothing on other platforms.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ spawnSync: [] as unknown[], execFileSync: [] as unknown[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawnSync: (...args: unknown[]) => {
      calls.spawnSync.push(args[2]);
      return { status: 1, stdout: '' };
    },
    execFileSync: (...args: unknown[]) => {
      calls.execFileSync.push(args[2]);
      return '';
    },
  };
});

const { captureLookup } = await import('@/command/cli/ports/port-holder.js');
const { repoIdentity } = await import('@/command/cli/project-name.js');
const { gitTracks } = await import('@/machine/git-tracks.js');

const HIDE: unknown = expect.objectContaining({ windowsHide: true });

describe('the daemon hides the console of each child process it starts', () => {
  beforeEach(() => {
    calls.spawnSync.length = 0;
    calls.execFileSync.length = 0;
  });

  it('captureLookup (the PowerShell and lsof port lookup)', () => {
    captureLookup('powershell', ['-NoProfile']);
    expect(calls.spawnSync).toEqual([HIDE]);
  });

  it('repoIdentity (git config)', () => {
    repoIdentity('/tmp');
    expect(calls.execFileSync.length).toBeGreaterThan(0);
    for (const options of calls.execFileSync) {
      expect(options).toEqual(HIDE);
    }
  });

  it('gitTracks (git check-ignore)', () => {
    gitTracks(`/tmp/hide-console-${String(process.pid)}/file`);
    expect(calls.spawnSync).toEqual([HIDE]);
  });
});
