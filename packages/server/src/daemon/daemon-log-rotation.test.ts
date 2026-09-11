import { describe, expect, it } from 'vitest';
import { MAX_DAEMON_LOG_BYTES, rotateDaemonLog } from './daemon.js';

/**
 * The daemon log was unbounded, and a real dev machine reached 24MB on a single port.
 *
 * That is not just untidy. It is the difference between a log somebody opens and a log somebody
 * gives up on — the same investigation that reported it also reported being unable to use the file
 * at all — and it is disk nothing ever reclaims.
 */
describe('daemon log rotation', () => {
  const renames: { from: string; to: string }[] = [];
  const deps = (size: number) => ({
    fileSize: () => size,
    renameFile: (from: string, to: string) => void renames.push({ from, to }),
  });

  it('leaves a log that is under the cap alone', () => {
    renames.length = 0;
    expect(rotateDaemonLog('/x/daemon-4400.log', deps(1024))).toBe(false);
    expect(renames).toEqual([]);
  });

  it('rolls a log that is over the cap to .1', () => {
    renames.length = 0;
    expect(rotateDaemonLog('/x/daemon-4400.log', deps(MAX_DAEMON_LOG_BYTES + 1))).toBe(true);
    expect(renames).toEqual([{ from: '/x/daemon-4400.log', to: '/x/daemon-4400.log.1' }]);
  });

  it('caps below the 24MB that was actually observed in the field', () => {
    expect(MAX_DAEMON_LOG_BYTES).toBeLessThan(24 * 1024 * 1024);
  });

  it('never lets housekeeping stop a daemon from starting', () => {
    // Failing to launch because a log could not be renamed is strictly worse than a large file.
    const throwing = {
      fileSize: () => MAX_DAEMON_LOG_BYTES + 1,
      renameFile: () => {
        throw new Error('EPERM');
      },
    };
    expect(() => rotateDaemonLog('/x/daemon-4400.log', throwing)).not.toThrow();
    expect(rotateDaemonLog('/x/daemon-4400.log', throwing)).toBe(false);
  });
});
