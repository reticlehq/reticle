/**
 * How long this daemon has waited with no app connected.
 *
 * This is what survived `instrumentation_stalled`. The EVENT was removed: it claimed to separate
 * "never wired" from "died before reporting" and did not, because it only fired on a flush tick or a
 * graceful shutdown, so a killed daemon was invisible to it exactly as before. Everything it carried
 * is derivable from `daemon_started` minus `app_instrumented`, joined on `sessionId` — and that set
 * difference is strictly MORE complete, because it does catch the killed daemons. A second way to
 * compute the same number that disagrees with the first is worse than not having it.
 *
 * The CLOCK is a different thing and stays. Two live features read it, neither of them a metric: the
 * no-session diagnosis tells an agent how long this daemon has been waiting, and the daemon warns on
 * stderr when a run passes the threshold with nothing connected. Both are help for somebody stuck
 * mid-install, which is the moment they are least able to work it out themselves.
 *
 * It lives under `session/` rather than `telemetry/` now, beside the two files that read it. The old
 * home is why the removal looked like it would take the diagnosis with it.
 */
import { appEverConnected } from '../telemetry/app-instrumented.js';

/**
 * When a run with nothing connected is worth mentioning to a human.
 *
 * Ten minutes sits well past setup latency — reading a doc, restarting a dev server, opening a tab —
 * and short enough that the warning still arrives while somebody is at the keyboard.
 */
export const STALL_AFTER_MS = 10 * 60 * 1000;

let daemonStartedAt: number | undefined;

/** Start the clock, from the same place the instrumentation clock is marked. */
export function markStallClock(now: number): void {
  daemonStartedAt = now;
}

/**
 * How long this daemon has waited with no app, or undefined if the question is moot.
 *
 * Moot means the clock was never started, or an app already connected. A run that starts slowly and
 * then works has nothing to report, which is why this returns undefined rather than a duration.
 */
export function stallUptime(now: number): number | undefined {
  if (daemonStartedAt === undefined) return undefined;
  if (appEverConnected()) return undefined;
  return now - daemonStartedAt;
}

/** Tests only. */
export function resetStallClock(): void {
  daemonStartedAt = undefined;
}
