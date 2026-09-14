import {
  OnboardingPhase,
  OnboardingStepSchema,
  OnboardingStepStatus,
  TelemetryEventKind,
  type OnboardingStep,
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
export async function reportOnboardingStep(step: OnboardingStep): Promise<boolean> {
  const parsed = OnboardingStepSchema.safeParse(step);
  // A malformed step is DROPPED rather than sent or thrown. Sending it would put unvalidated text on
  // the wire; throwing would let a metric change what the user's install does, which rule 5 forbids.
  if (!parsed.success) return false;
  return getTelemetry().emit(TelemetryEventKind.ONBOARDING_STEP, { onboarding: parsed.data });
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
