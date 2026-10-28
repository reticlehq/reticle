import {
  OnboardingPhase,
  OnboardingStepSchema,
  OnboardingStepStatus,
  TelemetryEventKind,
  type OnboardingStep,
  type OnboardingStop,
} from '@reticlehq/core/telemetry';
import { getTelemetry } from './telemetry.js';

/**
 * The one place an onboarding step is reported.
 *
 * A chokepoint for the reason rule 1 gives: telemetry fails silently, so a second emit site is a
 * second place that can quietly stop firing, and nothing goes red when it does. Every phase reports
 * here, and this is the only thing that knows the event kind.
 *
 * VALIDATED before sending, which is not ceremony. `step` is a free-ish string in the schema and
 * the whole value of the funnel is that it holds OUR names — a path, a URL or an error message
 * arriving as a step name would be a rule-3 leak that no reader would ever notice, because a funnel
 * with one weird row still renders.
 */
export async function reportOnboardingStep(
  step: OnboardingStep,
  opts: { detach?: boolean } = {},
): Promise<boolean> {
  const parsed = OnboardingStepSchema.safeParse(step);
  // A malformed step is DROPPED rather than sent or thrown. Sending it would put unvalidated text on
  // the wire; throwing would let a metric change what the user's install does, which rule 5 forbids.
  if (!parsed.success) {
    return false;
  }
  return getTelemetry().emit(TelemetryEventKind.ONBOARDING_STEP, {
    onboarding: parsed.data,
    ...(true === opts.detach ? { detach: true } : {}),
  });
}

/** One stop: the rung it blocked and its name. The status is always `failed`. */
export type StopRow = Omit<OnboardingStep, 'status' | 'stop'> & { stop: OnboardingStop };

const stopsSent = new Set<OnboardingStop>();

/**
 * Report one stop on the path to a first verdict, once for each process and stop name.
 *
 * A daemon can fail to launch Chromium on every lease. One row says the stop happened here; more
 * rows count retries, not people. Use `detach` from a CLI that exits next, or the row is lost.
 */
export function reportOnboardingStop(row: StopRow, opts: { detach?: boolean } = {}): void {
  if (stopsSent.has(row.stop)) {
    return;
  }
  stopsSent.add(row.stop);
  void reportOnboardingStep({ ...row, status: OnboardingStepStatus.FAILED }, opts);
}

/** Tests only: forget the stops this process sent. */
export function resetOnboardingStops(): void {
  stopsSent.clear();
}

/**
 * Time a step and report it, whatever happens to it.
 *
 * The `finally` is the point. A step that is STARTED and never resolved is indistinguishable in a
 * funnel from one that was never reached, so an exception escaping without a report turns a FAILURE
 * into an absence — and absence is how every drop-off is already explained away.
 */
export async function trackOnboardingStep<T>(
  phase: OnboardingPhase,
  step: string,
  run: () => Promise<T>,
  opts: { now?: () => number; unattended?: boolean; stack?: string } = {},
): Promise<T> {
  const now = opts.now ?? ((): number => Date.now());
  const started = now();
  const common = {
    phase,
    step,
    ...(opts.unattended === undefined ? {} : { unattended: opts.unattended }),
    ...(opts.stack === undefined ? {} : { stack: opts.stack }),
  };
  void reportOnboardingStep({ ...common, status: OnboardingStepStatus.STARTED });
  try {
    const result = await run();
    void reportOnboardingStep({
      ...common,
      status: OnboardingStepStatus.COMPLETED,
      elapsedMs: now() - started,
    });
    return result;
  } catch (error) {
    void reportOnboardingStep({
      ...common,
      status: OnboardingStepStatus.FAILED,
      elapsedMs: now() - started,
      // The CLASS of failure, never the message: a message carries paths, hostnames and whatever
      // the user typed. `reason` is capped at 64 for the same reason.
      reason: error instanceof Error ? error.constructor.name : 'unknown',
    });
    throw error;
  }
}
