import {
  OnboardingPhase,
  OnboardingStepStatus,
  type OnboardingStep,
} from '@reticlehq/core/telemetry';
import { reportOnboardingStep } from '../telemetry/onboarding-funnel.js';

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
 * Asking for the tour is a fact here, and so is having been shown what Reticle is. Whether the
 * reader then looked, acted or proved is not — even on `tutorial --run`, which drives the demo: those
 * three are reported by the daemon at the first look / act / verdict it actually witnesses, through
 * the dispatch chokepoint, because that is the only place they are observations rather than claims.
 * Reporting them from here would turn "the tour reached step four" into "somebody verified something",
 * which is the same substitution the fourth step of the tour exists to warn about.
 */
export function reportTutorialShown(): void {
  for (const step of ['tour_started', 'concept_shown'] as const) {
    reportStepFromCli({
      phase: OnboardingPhase.ONBOARD,
      step,
      status: OnboardingStepStatus.COMPLETED,
    });
  }
}
