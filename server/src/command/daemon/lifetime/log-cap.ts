/**
 * How big the daemon's log may get, and the three things that keep it there.
 *
 * `rotateDaemonLog` runs at spawn. `guardDaemonLog` runs while the daemon lives, because a detached
 * daemon writes for days — a beat every thirty seconds plus every session, tool call and reconnect —
 * and a size checked once at start is a size nothing will ever check again. A log measured at 98% of
 * the cap and still climbing had no remaining mechanism that would trim it, and the tracker carries
 * the same failure with a bigger number: the daemon log filling a disk, and a user who left over it.
 * `pruneOldDaemonLogs` is the other half of the disk — one file per port ever bound, forever.
 *
 * Here rather than in daemon.ts because the size check has to be called from the heartbeat, and
 * `lifetime` is a sink: nothing in it may reach back into its parent. Same reason nothing here
 * logs — the caller that has a logger emits `DAEMON_LOG_TRUNCATED_EVENT`.
 */

import { fstatSync, ftruncateSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How large a daemon log may get before it is rolled over to `<name>.1`.
 *
 * It was unbounded. A real dev machine reached **24MB** on one port, which is not merely untidy: it
 * is the difference between a log somebody opens and a log somebody gives up on, and it is disk that
 * nothing ever reclaims. One previous generation is kept, because the question people bring to this
 * file ("what happened just now?") is answered by the current one and the question they bring next
 * ("and just before that?") is answered by the other.
 */
export const MAX_DAEMON_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Reclaim a log that has already run past `max`, by TRUNCATING IT IN PLACE. Returns bytes reclaimed.
 *
 * The one definition behind both logs Reticle writes: the daemon log, and the MCP proxy log in
 * surface/mcp/proxy/proxy-log.ts, which delegates to this. An uncapped proxy log has filled a disk
 * and broken unrelated builds, Docker and ordinary shell commands with ENOSPC; the daemon log is
 * larger, longer-lived and had the same hole, so it gets the same answer rather than a second one.
 *
 * In place, never renamed or unlinked: a rename moves the bytes without reclaiming a byte, and a
 * file a running process still holds open keeps its blocks allocated after an unlink until that
 * handle closes. `: > ~/.reticle/daemon-4400.log` is the operation being copied here.
 *
 * Best-effort, in the same spirit as `rotateDaemonLog`: dying over housekeeping is strictly worse
 * than a large file.
 */
export function recoverOversizedLog(
  deps: { size(): number; truncate(): void },
  max: number = MAX_DAEMON_LOG_BYTES,
): number {
  try {
    const size = deps.size();
    if (max >= size) return 0;
    deps.truncate();
    return size;
  } catch {
    return 0;
  }
}

/**
 * The daemon's log, as the daemon itself can address it: its own stderr.
 *
 * `spawnDaemon` hands the child `stdio: ['ignore', logFd, logFd]`, so inside a running daemon fd 2
 * IS `daemon-<port>.log`, opened with O_APPEND — which is what makes truncating it safe: an
 * appending write always lands at the new end of file, so there is no sparse hole and no lost
 * handle. No path, no port and no second open are needed to reach it. When the daemon runs in the
 * foreground fd 2 is a terminal, whose reported size is 0, so this is a no-op there.
 */
const DAEMON_LOG_FD = 2;

/** Emitted into the fresh log immediately after a truncation, so the gap explains itself. */
export const DAEMON_LOG_TRUNCATED_EVENT = 'reticle_daemon_log_truncated';

const daemonLogFdOps = {
  size: (): number => fstatSync(DAEMON_LOG_FD).size,
  truncate: (): void => ftruncateSync(DAEMON_LOG_FD, 0),
};

/** Keep a RUNNING daemon's log under the cap. Returns the bytes reclaimed, 0 when it was fine. */
export function guardDaemonLog(
  deps: { size(): number; truncate(): void } = daemonLogFdOps,
): number {
  return recoverOversizedLog(deps);
}

/**
 * How long a daemon log outlives its daemon.
 *
 * Every port ever bound leaves a `daemon-<port>.log` behind and nothing removed any of them — one
 * machine held 128 files in `~/.reticle`, logs the large majority. Nothing enumerates them either:
 * every reader (`doctor`, the startup-cause reader, the lifecycle messages) opens the log of the
 * port it is asking about right now, so a log for a port that will never be bound again is read by
 * nobody. A week is long enough to still have last Tuesday's crash when somebody asks about it.
 */
export const DAEMON_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete daemon logs nothing has written to in the retention window. Returns the names removed.
 *
 * Age is the whole test, and it doubles as the liveness probe: a live daemon beats into its log
 * every thirty seconds, so a log older than a week has no daemon behind it by construction.
 * Best-effort throughout — a log that will not delete is not a reason to fail a daemon start.
 */
export function pruneOldDaemonLogs(home: string, nowMs: number): string[] {
  const pruned: string[] = [];
  let files: string[];
  try {
    files = readdirSync(home);
  } catch {
    return pruned; // no ~/.reticle yet → nothing to prune
  }
  for (const file of files) {
    if (null === /^daemon-\d+\.log(\.1)?$/.exec(file)) continue;
    const path = join(home, file);
    try {
      if (DAEMON_LOG_RETENTION_MS > nowMs - statSync(path).mtimeMs) continue;
      unlinkSync(path);
      pruned.push(file);
    } catch {
      // unreadable or already gone — either way it is not this process's problem
    }
  }
  return pruned;
}
