/**
 * The FOREIGN retry: `reticle open` right after `reticle restart` read FOREIGN while the daemon
 * was still answering its first /status (reticlehq/reticle#2126) — the refusal named a holder it
 * could not identify, and `reticle status` seconds later showed the daemon fine. The pid file is
 * the tell: while the recorded pid is alive, one more probe is worth more than a refusal.
 */

import { describe, expect, it, vi } from 'vitest';

import { PortPresence } from '@/command/daemon/binding/port-presence.js';
import { ensureDaemon, type EnsureDaemonDeps } from './ensure-daemon.js';

const PORT = 4400;

function harness(
  sequence: PortPresence[],
  overrides: Partial<EnsureDaemonDeps> = {},
): {
  deps: EnsureDaemonDeps;
  seen: PortPresence[];
  spawnDaemon: ReturnType<typeof vi.fn>;
  onUsable: ReturnType<typeof vi.fn>;
} {
  const seen: PortPresence[] = [];
  const probe = (): Promise<PortPresence> =>
      Promise.resolve(
        sequence[Math.min(seen.length, sequence.length - 1)] ?? PortPresence.FOREIGN,
      );
  const spawnDaemon = vi.fn(async () => {});
  const onUsable = vi.fn(async () => {});
  return {
    seen,
    spawnDaemon,
    onUsable,
    deps: {
      probe,
      readPid: () => 4321,
      isAlive: () => true,
      retryDelayMs: 1,
      spawnDaemon,
      onUsable,
      ...overrides,
    },
  };
}

describe('ensureDaemon', () => {
  it('retries once when FOREIGN matches a live recorded pid and finds the daemon', async () => {
    const { deps, seen, spawnDaemon, onUsable } = harness([
      PortPresence.FOREIGN,
      PortPresence.DAEMON,
    ]);

    await expect(ensureDaemon(PORT, deps)).resolves.toBeUndefined();

    expect(seen).toEqual([PortPresence.FOREIGN, PortPresence.DAEMON]);
    expect(onUsable).toHaveBeenCalledWith(PORT);
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('throws when the second probe still reads FOREIGN', async () => {
    const { deps, seen, spawnDaemon } = harness([PortPresence.FOREIGN, PortPresence.FOREIGN]);

    await expect(ensureDaemon(PORT, deps)).rejects.toThrow(/4400/);
    expect(seen).toEqual([PortPresence.FOREIGN, PortPresence.FOREIGN]);
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('throws without a second probe when no pid is recorded', async () => {
    const { deps, seen } = harness([PortPresence.FOREIGN], { readPid: () => null });

    await expect(ensureDaemon(PORT, deps)).rejects.toThrow();
    expect(seen).toEqual([PortPresence.FOREIGN]);
  });

  it('throws without a second probe when the recorded pid is dead', async () => {
    const { deps, seen } = harness([PortPresence.FOREIGN], { isAlive: () => false });

    await expect(ensureDaemon(PORT, deps)).rejects.toThrow();
    expect(seen).toEqual([PortPresence.FOREIGN]);
  });

  it('does not retry a DAEMON reading', async () => {
    const { deps, seen, onUsable } = harness([PortPresence.DAEMON]);

    await expect(ensureDaemon(PORT, deps)).resolves.toBeUndefined();
    expect(seen).toEqual([PortPresence.DAEMON]);
    expect(onUsable).toHaveBeenCalledTimes(1);
  });

  it('spawns without retrying a FREE reading', async () => {
    const { deps, seen, spawnDaemon } = harness([PortPresence.FREE]);

    await expect(ensureDaemon(PORT, deps)).resolves.toBeUndefined();
    expect(seen).toEqual([PortPresence.FREE]);
    expect(spawnDaemon).toHaveBeenCalledWith(PORT);
  });
});
