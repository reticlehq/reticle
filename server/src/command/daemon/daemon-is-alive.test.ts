/**
 * A process that the caller may not signal is still alive.
 *
 * `process.kill(pid, 0)` throws `EPERM` when the process exists but the caller has no right to signal
 * it, and `ESRCH` when there is no such process. `isAlive` read every throw as "dead". On Windows, a
 * daemon that WMI started can refuse that check, so a start found the live daemon "dead", reported
 * `daemon_died_unclean`, and started a second daemon that could not bind the port. In the Windows
 * install gate the log showed the daemon "dead" six seconds after it was ready, and the port still
 * held.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAlive } from './daemon.js';

const failWith = (code: string) => (): never => {
  throw Object.assign(new Error(code), { code });
};

describe('isAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is true for a process that exists but may not be signalled (EPERM)', () => {
    vi.spyOn(process, 'kill').mockImplementation(failWith('EPERM'));
    expect(isAlive(4242)).toBe(true);
  });

  it('is false when there is no such process (ESRCH)', () => {
    vi.spyOn(process, 'kill').mockImplementation(failWith('ESRCH'));
    expect(isAlive(4242)).toBe(false);
  });

  it('is true for a process that may be signalled', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(isAlive(4242)).toBe(true);
  });
});
