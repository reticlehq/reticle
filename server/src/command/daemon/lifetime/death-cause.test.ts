/**
 * Why a daemon died, read from its own log by the start that finds it dead.
 *
 * `daemon_died_unclean` carried only the age. A reboot, a host that kills the process tree of an MCP
 * server, an out-of-memory kill and a crash at startup all sent the same event. On Windows the cause
 * (the agent's Job Object) took a CI probe to find; on macOS a few daemons still die while a client
 * is connected, and nothing told them apart.
 */
import { describe, expect, it } from 'vitest';
import { DaemonEnd } from '@reticlehq/core';
import { deathCauseFromLog } from './death-cause.js';

const START = Date.parse('2026-10-27T05:00:00.000Z');
const at = (ms: number): string => new Date(START + ms).toISOString();
const line = (ms: number, event: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ t: at(ms), event, ...fields });
const beat = (ms: number, fields: Record<string, unknown> = {}): string =>
  line(ms, 'reticle_daemon_alive', {
    uptimeMs: ms,
    everyMs: 30_000,
    sessions: 1,
    served: true,
    ...fields,
  });

describe('deathCauseFromLog', () => {
  it('reads a silent death from the last beat: how long it was silent, and what it was doing', () => {
    const log = [beat(30_000, { rssMb: 180 }), beat(60_000, { sessions: 2, rssMb: 210 })].join(
      '\n',
    );
    expect(deathCauseFromLog(log, START, START + 600_000)).toEqual({
      end: DaemonEnd.DIED_SILENTLY,
      silentMs: 540_000,
      sessions: 2,
      served: true,
      rssMb: 210,
    });
  });

  it('names the signal when the daemon logged one', () => {
    const log = [
      beat(30_000),
      line(40_000, 'reticle_daemon_signalled', { signal: 'SIGTERM' }),
      line(40_001, 'reticle_daemon_exiting', { code: 0 }),
    ].join('\n');
    expect(deathCauseFromLog(log, START, START + 50_000)).toMatchObject({
      end: DaemonEnd.SIGNALLED,
      signal: 'SIGTERM',
    });
  });

  it('reads the error code of a daemon that failed at startup, and never its message', () => {
    const log = line(500, 'reticle_daemon_start_failed', {
      error: 'listen EADDRINUSE: address already in use 127.0.0.1:4400 in /Users/someone/app',
    });
    const cause = deathCauseFromLog(log, START, START + 5_000);
    expect(cause).toMatchObject({ end: DaemonEnd.UNKNOWN, error: 'EADDRINUSE' });
    expect(JSON.stringify(cause)).not.toContain('someone');
  });

  it('reads the code from a raw Node stack that a crash wrote before any log line', () => {
    const log = [
      line(-90_000, 'reticle_daemon_alive'),
      'node:internal/modules/esm/resolve:265',
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\\Users\\someone\\x.js'",
    ].join('\n');
    const cause = deathCauseFromLog(log, START, START + 1_000);
    expect(cause.error).toBe('ERR_MODULE_NOT_FOUND');
    expect(JSON.stringify(cause)).not.toContain('someone');
  });

  it('ignores the lines of an earlier daemon in the same append-only log', () => {
    const log = [
      line(-120_000, 'reticle_daemon_signalled', { signal: 'SIGKILL' }),
      line(-119_999, 'reticle_daemon_exiting', { code: 0 }),
      beat(30_000),
    ].join('\n');
    expect(deathCauseFromLog(log, START, START + 300_000)).toMatchObject({
      end: DaemonEnd.DIED_SILENTLY,
    });
  });

  it('says unknown, and adds nothing, for a log with no line from this daemon', () => {
    expect(deathCauseFromLog('', START, START + 1_000)).toEqual({ end: DaemonEnd.UNKNOWN });
    expect(deathCauseFromLog('not json\n{"t":"bad"}', START, START + 1_000)).toEqual({
      end: DaemonEnd.UNKNOWN,
    });
  });
});
