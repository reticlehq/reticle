/**
 * Stale-daemon reclaim: a crashed daemon must not leave a pidfile that makes a port look "taken"
 * or pollutes discovery. reclaimStaleDaemons sweeps pidfiles whose process is no longer alive.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reclaimStaleDaemons } from './daemon.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reticle-reclaim-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writePidFile(port: number, pid: number): void {
  writeFileSync(join(home, `daemon-${port}.pid`), String(pid), 'utf8');
}

describe('reclaimStaleDaemons', () => {
  it('removes pidfiles whose process is dead, keeps live ones', () => {
    writePidFile(4400, 111); // dead
    writePidFile(4401, 222); // live
    writePidFile(4402, 333); // dead

    const alive = (pid: number): boolean => pid === 222;
    const reclaimed = reclaimStaleDaemons(home, alive).sort((a, b) => a - b);

    expect(reclaimed).toEqual([4400, 4402]);
    expect(existsSync(join(home, 'daemon-4400.pid'))).toBe(false);
    expect(existsSync(join(home, 'daemon-4401.pid'))).toBe(true);
    expect(existsSync(join(home, 'daemon-4402.pid'))).toBe(false);
  });

  it('treats an unreadable/garbage pidfile as stale', () => {
    writeFileSync(join(home, 'daemon-4400.pid'), 'not-a-number', 'utf8');
    const reclaimed = reclaimStaleDaemons(home, () => true);
    expect(reclaimed).toEqual([4400]);
    expect(existsSync(join(home, 'daemon-4400.pid'))).toBe(false);
  });

  it('ignores non-pidfile entries and a missing home dir', () => {
    writeFileSync(join(home, 'daemon-4400.log'), 'log', 'utf8');
    writeFileSync(join(home, 'unrelated.txt'), 'x', 'utf8');
    const reclaimed = reclaimStaleDaemons(home, () => false);
    expect(reclaimed).toEqual([]);
    expect(readdirSync(home).sort()).toEqual(['daemon-4400.log', 'unrelated.txt']);

    expect(reclaimStaleDaemons(join(home, 'does-not-exist'), () => false)).toEqual([]);
  });

  it('a live daemon is never reclaimed even if other pidfiles are stale', () => {
    writePidFile(4400, 999); // dead
    writePidFile(4401, process.pid); // genuinely alive
    const reclaimed = reclaimStaleDaemons(home); // real isAlive probe
    expect(reclaimed).toEqual([4400]);
    expect(existsSync(join(home, 'daemon-4401.pid'))).toBe(true);
  });
});
