import type { OnboardingStep } from '@reticlehq/core/telemetry';
import { reportOnboardingStep } from '@/telemetry/onboarding-funnel.js';

/**
 * The CLI's half of the setup funnel.
 *
 * It lives in `command/` and not in `command/cli/` for a reason the reach guard found: `cli/` does
 * not reach `telemetry/`, and adding that edge made a MUTUAL pair — two directories that each need
 * the other cannot be read, moved or tested apart. `command/` already reaches telemetry, so the
 * reporter is built here and handed down to every command that needs one.
 */
export const reportStepFromCli = (step: OnboardingStep): void => {
  void reportOnboardingStep(step);
};
