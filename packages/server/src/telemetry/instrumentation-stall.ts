/**
 * When a daemon has waited long enough that no app is coming.
 *
 * `app_instrumented` fires on success and only on success, so the population that matters most —
 * daemons that never get an app wired at all — exists in the data only as an absence. An absence is
 * the one thing telemetry cannot interpret: it cannot separate "nothing was ever wired" from "the
 * process was killed before it could say so" from "we never sent the event". The funnel breaks at
 * exactly this step and nowhere else, which makes it the one silence worth converting into a signal.
 *
 * Once per daemon run, and never after an app has connected. A daemon that takes a while and then
 * works reports nothing at all: the question is "did this run ever get an app", and a run that did
 * is not stalled no matter how long it took.
 *
 * The threshold is a judgement, not a measurement, and it is deliberately generous. Someone running
 * `init` and then going to make coffee has not hit a defect, and calling that a stall would drown
 * the real signal in ordinary human latency.
 *
 * Read the result against `agentAttached`, which is what makes it actionable: a stalled daemon with
 * no agent is somebody who installed and walked away, and is not a defect. A stalled daemon WITH an
 * agent attached is the failure the product actually has — the tools are loaded, something is asking
 * for them, and there is nothing on the other end to drive.
 */

import { TelemetryEventKind } from '@reticlehq/core';
import { getTelemetry } from './telemetry.js';
import { appEverConnected } from './app-instrumented.js';

/**
 * How long a daemon may sit with no app before it counts as stalled.
 *
 * Ten minutes sits well past setup latency — reading a doc, restarting a dev server, opening a tab —
 * and well short of the half-hour idle windows that dominate the field, so a stall is reported while
 * the session is still alive rather than inferred from its corpse.
 */
export const STALL_AFTER_MS = 10 * 60 * 1000;

let reported = false;
let daemonStartedAt: number | undefined;

/** Start the clock. Called from the same place the instrumentation clock is marked. */
export function markStallClock(now: number): void {
  daemonStartedAt = now;
  reported = false;
}

export interface StallFacts {
  /** Whether this project has a projectId stamped — i.e. `init` has run here. */
  initialized: boolean;
  /** Whether an MCP client is attached right now. */
  agentAttached: boolean;
}

/**
 * Report a stalled install, at most once per daemon run.
 *
 * Returns whether it emitted, so the caller's test can assert the once-only rule without reaching
 * into the telemetry client. Best-effort like every other metric here: it must never be the reason
 * a daemon misbehaves.
 */
export function reportInstrumentationStall(
  facts: StallFacts,
  now: () => number = () => Date.now(),
  opts: { atShutdown?: boolean } = {},
): boolean {
  if (reported) return false;
  // An app arrived. Whatever this run was, it was not stalled.
  if (appEverConnected()) return false;
  if (daemonStartedAt === undefined) return false;
  const waited = now() - daemonStartedAt;
  // The threshold is a guard against crying stall seconds after boot. At SHUTDOWN there is nothing
  // left to wait for: this daemon ran, no app ever connected, and it is now gone. That is a fact
  // rather than an inference, and it does not become truer at ten minutes than at five.
  //
  // Skipping it here is what makes the event able to see anything at all. An UNATTENDED daemon
  // idle-exits at DAEMON_IDLE_SHUTDOWN_MS (5 min), well short of STALL_AFTER_MS (10) — only an
  // attached one gets the six-times grace that reaches the threshold. So on the periodic path alone
  // `agentAttached` was forced to true on every row, and the bucket this event exists for —
  // installed it, walked away, never wired the app — could not appear in the data at all.
  //
  // `msWaited` still carries the duration, so a consumer that wants to exclude short runs can do it
  // on the data instead of being unable to see them.
  if (true !== opts.atShutdown && waited < STALL_AFTER_MS) return false;

  reported = true;
  try {
    void getTelemetry().emit(TelemetryEventKind.INSTRUMENTATION_STALLED, {
      stall: {
        initialized: facts.initialized,
        agentAttached: facts.agentAttached,
        msWaited: Math.max(0, waited),
      },
    });
  } catch {
    /* never let a metric interfere with a running daemon */
  }
  return true;
}

/**
 * How long this daemon has waited with no app, or undefined if the question is moot.
 *
 * Moot means: the clock was never started, or an app already connected. Callers use this to
 * surface the stall to user-facing channels without coupling to the telemetry event itself.
 */
export function stallUptime(now: number): number | undefined {
  if (daemonStartedAt === undefined) return undefined;
  if (appEverConnected()) return undefined;
  return now - daemonStartedAt;
}

/** Tests only. */
export function resetInstrumentationStall(): void {
  reported = false;
  daemonStartedAt = undefined;
}
