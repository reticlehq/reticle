/**
 * When an app carrying the SDK first reaches this daemon.
 *
 * Registering the MCP server and instrumenting an app are separate acts, done by different commands.
 * This event marks the second one. It must not be inferred from a window counter, which resets on
 * every flush and so reports fewer instrumented installs than there are installs calling tools.
 *
 * Once per daemon run, on the FIRST app connect only. A page that reloads, or an app that opens five
 * tabs, must not read as five instrumented installs — the question is "did this install ever get an
 * app wired", and it has one answer per run.
 *
 * Names, never values: whether `init` had been run and whether an agent was attached — never the
 * project path, the URL, or anything from the page. The stack is deliberately NOT repeated here;
 * `project_profiled` already carries it on the same daemon run, so the two join on sessionId.
 */

import {
  OnboardingPhase,
  OnboardingStepStatus,
  TelemetryEventKind,
} from '@reticlehq/core/telemetry';
import { getTelemetry } from './telemetry.js';
import { reportOnboardingStep } from './onboarding-funnel.js';

let reported = false;
/** Set at daemon start so the first connect can report how long the install sat un-instrumented. */
let daemonStartedAt: number | undefined;

export function markInstrumentationClock(now: number): void {
  daemonStartedAt = now;
  reported = false;
}

interface InstrumentationFacts {
  /** Whether this project has a projectId stamped — i.e. `init` has run here. */
  initialized: boolean;
  /**
   * Whether an MCP client was attached when the app arrived.
   *
   * Both halves present is the only state in which Reticle can do anything, and it is worth being
   * able to see the two orders apart: an app that connects with no agent attached is a person
   * setting up, while an agent that has been waiting is a session about to do work.
   */
  agentAttached: boolean;
}

/**
 * Report the first instrumented app of this daemon run. Best-effort and idempotent — a metric must
 * never be the reason a session fails to register.
 */
export function reportAppInstrumented(
  facts: InstrumentationFacts,
  now: () => number = () => Date.now(),
): void {
  if (reported) return;
  reported = true;
  try {
    void getTelemetry().emit(TelemetryEventKind.APP_INSTRUMENTED, {
      instrumentation: {
        initialized: facts.initialized,
        agentAttached: facts.agentAttached,
        // How long the daemon ran before an app showed up. Large values are the interesting ones:
        // Reticle was up, the agent had the tools, and nothing was wired for that whole time.
        msToFirstApp: daemonStartedAt === undefined ? 0 : Math.max(0, now() - daemonStartedAt),
      },
    });
    // The same fact, as an ordered step rather than a once-per-run flag, so it sits in the same
    // series as the steps either side of it. Reported here, at the one site that already knows,
    // rather than by a second listener that could drift from it.
    //
    // `instrumented` means files were written; THIS means a page actually dialled the bridge. Every
    // silent install bug so far has lived in the gap between those two.
    void reportOnboardingStep({
      phase: OnboardingPhase.FIRST_RUN,
      step: 'app_connected',
      status: OnboardingStepStatus.COMPLETED,
      ...(daemonStartedAt === undefined ? {} : { elapsedMs: Math.max(0, now() - daemonStartedAt) }),
    });
  } catch {
    /* never let a metric interfere with a page connecting */
  }
}

/**
 * Has an app connected to this daemon run at all?
 *
 * The same flag `reportAppInstrumented` uses for idempotency, read from outside. The stall check
 * needs exactly this question and must not answer it from a window counter, which resets on every
 * flush and would then report a long-instrumented daemon as freshly stalled.
 */
export function appEverConnected(): boolean {
  return reported;
}

/** Tests only. */
export function resetAppInstrumented(): void {
  reported = false;
  daemonStartedAt = undefined;
}
