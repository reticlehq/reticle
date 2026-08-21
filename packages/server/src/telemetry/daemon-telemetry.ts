/**
 * The daemon's telemetry lifecycle, in one place: start, the periodic flush that survives a kill, the
 * one-shot project profile, and the rich summary on shutdown.
 *
 * Extracted from `cli.ts` because it is a cohesive unit with its own timers and its own failure rule
 * (nothing here may ever be able to fail a daemon start), and because `cli.ts` is a dispatcher — the
 * more of this that lives there, the harder it is to see what a command actually does.
 */
import { TelemetryEventKind, type SessionSummary } from '@reticlehq/core';
import { getTelemetry } from './telemetry.js';
import { getSessionMetrics } from './session-metrics.js';
import { profileProject } from './project-profile.js';
import { startUpdateCheck } from '../update/update-nudge.js';
import { markDaemonStart } from './mcp-connection.js';
import { markInstrumentationClock } from './app-instrumented.js';
import {
  markStallClock,
  reportInstrumentationStall,
  STALL_AFTER_MS,
} from './instrumentation-stall.js';
import { readProjectId } from '../cli/cli-port.js';

/** Let the daemon finish coming up before walking the source tree for a profile. */
const PROJECT_PROFILE_DELAY_MS = 5_000;
/**
 * How often a running daemon rolls up its window.
 *
 * Exported because it is the BOUND ON WHAT IS LOST: a daemon that has served a tool never
 * idle-exits, so nothing calls shutdown, so its last partial window dies with the process. At 30
 * minutes against a median 28-minute session that meant the median session reported nothing at all.
 * Only non-empty windows emit, so a shorter interval costs nothing on the 74% of daemons that never
 * serve a tool.
 */
export const SESSION_FLUSH_MS = 5 * 60 * 1000;

/**
 * When a session first rolls up, independent of the periodic interval.
 *
 * The interval alone leaves a hole exactly the width of itself: a daemon SIGKILLed before its first
 * tick — a closed laptop, OOM, `kill -9`, a force-quit editor — reaches no shutdown handler and has
 * emitted nothing, so the whole session is invisible.
 *
 * In the field `daemon_started` outran `daemon_stopped` by a wide margin: **a meaningful share of
 * sessions never reported a summary at all.** Every "did anyone use Reticle" number is computed only
 * on the sessions that did, and undercounts by an unknown amount, which is the one thing a funnel
 * metric must not do.
 *
 * Ninety seconds is chosen against what it protects: a session that did real work usually does it
 * early (snapshot -> act -> assert is seconds), so one early tick captures nearly all of it. It
 * costs nothing on the daemons that dominate the population, because only a NON-EMPTY window emits
 * and 74% of daemons never serve a tool at all.
 */
export const FIRST_FLUSH_MS = 90 * 1000;

/** Stops the timers this installed. Called from the daemon's shutdown path. */
export interface DaemonTelemetry {
  /**
   * Emit the final, rich session summary and stop flushing. Safe to call more than once.
   *
   * AWAITABLE, and the daemon must await it. Every other send in the product is fire-and-forget
   * because losing one counter never matters — but this one carries the whole session, and the
   * process calls `process.exit(0)` immediately afterwards, which kills an in-flight POST. Verified
   * against a local capture server: fire-and-forget lost the event every single time. A send that
   * fails or hangs still cannot block the exit, because `emit` swallows its own errors and is bounded
   * by its own request timeout.
   */
  shutdown(exit?: SessionSummary['exit']): Promise<void>;
}

/**
 * Report the daemon as started, profile the project once, and keep the session counters flushing.
 * Every timer is `unref`'d so telemetry can never be the reason a daemon refuses to exit.
 */
export function installDaemonTelemetry(
  cwd: string,
  now: () => number = () => Date.now(),
): DaemonTelemetry {
  const metrics = getSessionMetrics(now);
  void getTelemetry().emit(TelemetryEventKind.DAEMON_STARTED);
  // Ask npm whether a newer Reticle exists, so the agent can tell the human. Nothing checked before
  // this, so a published fix was invisible until someone manually ran `reticle update`.
  startUpdateCheck(now);
  markDaemonStart(now());
  // Same clock, different half of the install: one measures how long before an AGENT attached, this
  // one how long before an APP did. The gap between them is the funnel.
  markInstrumentationClock(now());
  // The other half of the same question: how long before an app arrives, and a report if none does.
  markStallClock(now());

  // One profile per daemon start: what kind of project this is and how deeply Reticle is used in it.
  // Deferred off the boot path — it walks the source tree, and nothing about a daemon coming up
  // should wait on a filesystem scan.
  setTimeout(() => {
    try {
      void getTelemetry().emit(TelemetryEventKind.PROJECT_PROFILED, {
        project: profileProject(cwd, now()),
      });
    } catch {
      /* a profile is a nice-to-have; it must never touch the daemon */
    }
  }, PROJECT_PROFILE_DELAY_MS).unref();

  const flushWindow = (): void => {
    // BEFORE the idle return, and that ordering is the whole point: a stalled install produces an
    // empty window by definition — no app, so no tool calls, so nothing to roll up. Checking it
    // after the early return would make the one case this event exists for the one case it never
    // sees. It is self-limiting (once per run, never after an app connects), so running it on every
    // tick costs a comparison.
    const stalled = reportInstrumentationStall(
      {
        // Same test `app_instrumented` uses for the same field, so the success and failure events
        // stay directly comparable: a stamped projectId means `init` has run here.
        initialized: readProjectId(cwd) !== undefined,
        agentAttached: metrics.agentEverAttached,
      },
      now,
    );
    if (stalled) {
      const minutes = Math.round(STALL_AFTER_MS / 60_000);
      process.stderr.write(
        `[reticle] no app has connected after ${String(minutes)} minutes — ` +
          'the install may be incomplete. Restart the dev server if you added the Reticle plugin.\n',
      );
    }
    if (metrics.empty) return; // an idle window is not worth an event
    // NOT daemon_stopped: the daemon is still running. See SESSION_PROGRESS.
    void getTelemetry().emit(TelemetryEventKind.SESSION_PROGRESS, {
      session: metrics.summarize(false),
    });
    metrics.reset();
  };
  // The early one closes the hole the interval cannot: a session killed before its first tick had
  // emitted nothing at all. See FIRST_FLUSH_MS.
  const firstFlush = setTimeout(flushWindow, FIRST_FLUSH_MS);
  firstFlush.unref();
  const flush = setInterval(flushWindow, SESSION_FLUSH_MS);
  flush.unref();

  let stopped: Promise<void> | undefined;
  return {
    shutdown(exit?: SessionSummary['exit']): Promise<void> {
      // Both SIGTERM and the idle-shutdown path can call this; the second caller awaits the first
      // send rather than emitting a duplicate summary.
      stopped ??= (async () => {
        clearInterval(flush);
        clearTimeout(firstFlush);
        // Last chance to say that no app ever arrived. The periodic path cannot report an
        // UNATTENDED stall at all — that daemon idle-exits at five minutes and the periodic
        // threshold is ten — so without this the event only ever describes daemons with an agent
        // attached, which is not the population it was built to measure. Self-limiting: if the
        // interval already reported, this returns false and emits nothing.
        reportInstrumentationStall(
          {
            initialized: readProjectId(cwd) !== undefined,
            agentAttached: metrics.agentEverAttached,
          },
          now,
          { atShutdown: true },
        );
        // The rich one: the whole session in a single event — duration, the tool histogram, error
        // shapes, verifications, browser launches. This is what replaced the per-tool-call event.
        await getTelemetry().emit(TelemetryEventKind.DAEMON_STOPPED, {
          session: metrics.summarize(true, exit),
        });
      })();
      return stopped;
    },
  };
}
