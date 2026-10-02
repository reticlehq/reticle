/**
 * The daemon log was size-checked exactly ONCE, at spawn, and never again while the daemon ran.
 *
 * A daemon is detached and long-lived: it beats every thirty seconds, logs every session, every
 * tool call and every reconnect, and nothing looked at the file again until the next start. On a
 * machine measured while writing this, `daemon-4400.log` sat at 98% of the cap and still growing,
 * with nothing left to stop it. An issue on the tracker is the same failure with a bigger number:
 * the daemon log filling the disk, and a user who left over disk use.
 *
 * The MCP proxy already solved exactly this for its own log one directory away, and its comment
 * names the incident (ENOSPC breaking unrelated builds). This is that mechanism pointed at the
 * daemon log, from the one thing the daemon already does on a timer.
 */

import { describe, expect, it } from 'vitest';
import {
  DAEMON_LOG_RETENTION_MS,
  MAX_DAEMON_LOG_BYTES,
  guardDaemonLog,
  pruneOldDaemonLogs,
  recoverOversizedLog,
} from './lifetime/log-cap.js';
import { DaemonHeartbeat } from './lifetime/heartbeat.js';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** A log file that only exists as a byte count, so none of this needs a filesystem. */
function fakeLog(bytes = 0) {
  let size = bytes;
  return {
    size: (): number => size,
    truncate: (): void => void (size = 0),
    grow: (by: number): void => void (size += by),
    get bytes(): number {
      return size;
    },
  };
}

describe('a daemon that keeps writing past the cap', () => {
  it('does not grow without bound while it runs', () => {
    const file = fakeLog();
    const perBeat = 3 * 1024 * 1024;
    const hb = new DaemonHeartbeat({
      // Every beat is itself a write into this file, which is the point: the writer IS the process
      // that must notice. Anything else the daemon logs lands in the same file and counts the same.
      log: () => file.grow(perBeat),
      facts: () => ({ sessions: 0, served: false }),
      logGuard: file,
    });

    for (let i = 0; 20 > i; i += 1) hb.beat();

    // Bounded by the cap plus at most one beat's worth of writing after the last check. Without a
    // mid-run check this is 60MB and climbing, and nothing trims it until the daemon restarts.
    expect(file.bytes).toBeLessThanOrEqual(MAX_DAEMON_LOG_BYTES + perBeat);
  });

  it('leaves a log under the cap completely alone', () => {
    const file = fakeLog(1024);
    expect(guardDaemonLog(file)).toBe(0);
    expect(file.bytes).toBe(1024);
  });

  it('truncates in place rather than renaming, and says how much it reclaimed', () => {
    const file = fakeLog(MAX_DAEMON_LOG_BYTES + 512);
    expect(guardDaemonLog(file)).toBe(MAX_DAEMON_LOG_BYTES + 512);
    expect(file.bytes).toBe(0);
  });

  it('never lets housekeeping take the daemon down', () => {
    const throwing = {
      size: (): number => MAX_DAEMON_LOG_BYTES + 1,
      truncate: (): void => {
        throw new Error('EPERM');
      },
    };
    expect(() => guardDaemonLog(throwing)).not.toThrow();
    expect(guardDaemonLog(throwing)).toBe(0);
  });

  /** One definition, two callers: the proxy log's recovery is this same function. */
  it('is the same reclaim the proxy log uses', () => {
    const file = fakeLog(100);
    expect(recoverOversizedLog(file, 10)).toBe(100);
    expect(file.bytes).toBe(0);
  });
});

describe('logs of ports nobody will use again', () => {
  const home = (): string => mkdtempSync(join(tmpdir(), 'reticle-logs-'));
  const ageFile = (path: string, ms: number, now: number): void => {
    const seconds = (now - ms) / 1000;
    utimesSync(path, seconds, seconds);
  };

  it('removes a daemon log nothing has written to in the retention window', () => {
    const dir = home();
    const now = Date.now();
    for (const name of ['daemon-51234.log', 'daemon-51234.log.1', 'daemon-4400.log']) {
      writeFileSync(join(dir, name), 'x', 'utf8');
    }
    ageFile(join(dir, 'daemon-51234.log'), DAEMON_LOG_RETENTION_MS + 60_000, now);
    ageFile(join(dir, 'daemon-51234.log.1'), DAEMON_LOG_RETENTION_MS + 60_000, now);

    const pruned = pruneOldDaemonLogs(dir, now).sort();

    expect(pruned).toEqual(['daemon-51234.log', 'daemon-51234.log.1']);
    expect(existsSync(join(dir, 'daemon-51234.log'))).toBe(false);
    // A live daemon writes a heartbeat every thirty seconds, so a fresh mtime IS the liveness probe.
    expect(existsSync(join(dir, 'daemon-4400.log'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('touches nothing that is not a daemon log, and survives a missing directory', () => {
    const dir = home();
    const now = Date.now();
    for (const name of ['daemon-4400.pid', 'proxy-4400.log', 'registry-4400.json']) {
      writeFileSync(join(dir, name), 'x', 'utf8');
      ageFile(join(dir, name), DAEMON_LOG_RETENTION_MS * 10, now);
    }
    expect(pruneOldDaemonLogs(dir, now)).toEqual([]);
    expect(existsSync(join(dir, 'daemon-4400.pid'))).toBe(true);
    expect(existsSync(join(dir, 'proxy-4400.log'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    expect(pruneOldDaemonLogs(dir, now)).toEqual([]);
  });
});
