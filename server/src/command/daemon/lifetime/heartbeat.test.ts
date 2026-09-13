/**
 * A killed daemon and a tidy shutdown must not read identically.
 *
 * From a real gate run, `~/.reticle/daemon-4400.log` around a fixture that was scored as an install
 * failure:
 *
 *   10:49:05  mcp_daemon_started        port:4400            <- pid 2884
 *   10:51:13  session_connected         ...:3100
 *   10:51:29  mcp_daemon_started        port:4400  pid:4900  <- a SECOND daemon binds the SAME port
 *   10:51:40  reticle_daemon_signalled  SIGTERM
 *   10:51:40  reticle_daemon_exiting    code:0
 *             ...21 seconds with nothing listening; a fixture's whole connect window...
 *
 * pid 2884 died with NO exit event — `installExitTrace` hooks `'exit'`, which a SIGKILL never fires.
 * And the daemon that did exit logged `code: 0`, so the last line before the port went dark reads as
 * a tidy shutdown. A correct SvelteKit install was written up as an install failure on the strength
 * of that log.
 *
 * The fix is a regular beat, so SILENCE becomes the evidence — plus a reader that says so, since a
 * heartbeat nobody interprets is just more log volume.
 */
import { describe, it, expect } from 'vitest';
import {
  DAEMON_HEARTBEAT_EVENT,
  DaemonHeartbeat,
  DaemonEnd,
  classifyDaemonLife,
} from './heartbeat.js';

function fakeClock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('DaemonHeartbeat', () => {
  it('beats on every tick, so a gap in the log is the daemon being gone', () => {
    const beats: Record<string, unknown>[] = [];
    const clock = fakeClock();
    const hb = new DaemonHeartbeat({
      log: (_event, fields) => beats.push(fields),
      intervalMs: 1_000,
      clock: clock.now,
      facts: () => ({ sessions: 0, served: false }),
    });
    hb.beat();
    clock.advance(1_000);
    hb.beat();
    expect(beats).toHaveLength(2);
  });

  it('beats even when nothing is happening — an idle daemon is still a live one', () => {
    // The tempting optimisation (skip the beat when no work happened) destroys the whole signal:
    // silence would then mean "idle" OR "dead", which is the ambiguity being removed.
    const beats: unknown[] = [];
    const hb = new DaemonHeartbeat({
      log: (_e, f) => beats.push(f),
      intervalMs: 1_000,
      clock: fakeClock().now,
      facts: () => ({ sessions: 0, served: false }),
    });
    hb.beat();
    expect(beats).toHaveLength(1);
  });

  it('carries uptime and what the daemon is doing, so a reader can place the gap', () => {
    const clock = fakeClock(5_000);
    let fields: Record<string, unknown> = {};
    const hb = new DaemonHeartbeat({
      log: (_e, f) => (fields = f),
      intervalMs: 1_000,
      clock: clock.now,
      facts: () => ({ sessions: 2, served: true }),
    });
    clock.advance(30_000);
    hb.beat();
    expect(fields['uptimeMs']).toBe(30_000);
    expect(fields['sessions']).toBe(2);
    expect(fields['served']).toBe(true);
  });

  it('names its own interval, so a reader knows how long a gap has to be to mean something', () => {
    // Without this the reader has to hard-code the cadence, and the two drift the first time the
    // interval is tuned.
    let fields: Record<string, unknown> = {};
    const hb = new DaemonHeartbeat({
      log: (_e, f) => (fields = f),
      intervalMs: 15_000,
      clock: fakeClock().now,
      facts: () => ({ sessions: 0, served: false }),
    });
    hb.beat();
    expect(fields['everyMs']).toBe(15_000);
  });
});

describe('classifyDaemonLife', () => {
  const beat = (t: number, everyMs = 1_000) => ({
    t,
    event: DAEMON_HEARTBEAT_EVENT,
    everyMs,
  });

  it('a daemon still beating is alive', () => {
    expect(classifyDaemonLife([beat(1_000), beat(2_000)], 2_500).end).toBe(DaemonEnd.ALIVE);
  });

  it('a daemon that logged its exit ended cleanly', () => {
    const life = classifyDaemonLife(
      [beat(1_000), { t: 1_500, event: 'reticle_daemon_exiting', code: 0 }],
      9_000,
    );
    expect(life.end).toBe(DaemonEnd.CLEAN);
  });

  it('a daemon whose beat simply stopped DIED — the case that had no evidence at all', () => {
    // pid 2884. No exit event, no signal, no idle shutdown: the port went dark and the log said
    // nothing. This is the whole point of the file.
    const life = classifyDaemonLife([beat(1_000), beat(2_000)], 60_000);
    expect(life.end).toBe(DaemonEnd.DIED_SILENTLY);
    expect(life.silentForMs).toBe(58_000);
  });

  it('a signal before the exit is reported as the cause, not as a clean exit', () => {
    const life = classifyDaemonLife(
      [
        beat(1_000),
        { t: 1_400, event: 'reticle_daemon_signalled', signal: 'SIGTERM' },
        { t: 1_500, event: 'reticle_daemon_exiting', code: 0 },
      ],
      9_000,
    );
    expect(life.end).toBe(DaemonEnd.SIGNALLED);
    expect(life.signal).toBe('SIGTERM');
  });

  it('a log with no heartbeat at all is UNKNOWN, never "alive"', () => {
    // Every daemon predating this change, and any log the reader was pointed at by mistake. Claiming
    // health from the absence of a signal we never sent is exactly the confident-wrong this replaces.
    expect(classifyDaemonLife([{ t: 1_000, event: 'session_connected' }], 9_000).end).toBe(
      DaemonEnd.UNKNOWN,
    );
  });

  it('tolerates one missed beat before calling it dead', () => {
    // Timers slip under load, and a reader that cries death on a single late beat is a reader people
    // learn to ignore.
    expect(classifyDaemonLife([beat(1_000)], 2_400).end).toBe(DaemonEnd.ALIVE);
  });
});
