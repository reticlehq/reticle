import type { OnboardingStep } from '@reticlehq/core/telemetry';
import { reportOnboardingStep } from '../telemetry/onboarding-funnel.js';
import { tutorialShownSteps } from './cli/tutorial.js';

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

/**
 * The two ONBOARD steps `reticle tutorial` can honestly answer.
 *
 * The tutorial RENDERS; it does not run anything. So it knows the tour was asked for and the concept
 * was put in front of somebody, and it knows nothing about whether they then looked, acted or
 * proved. Claiming those here would report a journey nobody took. The remaining three are observed
 * by the daemon at the first look / act / verdict of a run, which is the only place they are a fact.
 */
export function reportTutorialShown(): void {
  for (const step of tutorialShownSteps()) reportStepFromCli(step);
}
