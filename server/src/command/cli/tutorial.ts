import {
  OnboardingPhase,
  OnboardingStepStatus,
  type OnboardingStep,
} from '@reticlehq/core/telemetry';

/**
 * The two ONBOARD steps a SHOWN tour can honestly answer.
 *
 * Here rather than in `command/cli-onboarding.ts`, because both callers live on this side of that
 * line: `cli/setup-mcp-cli.ts` shows the tour when a person is watching, and reaching back into
 * `command/` for the step names made `cli <-> command` a mutual pair — which `directory-reach`
 * refused, with the right advice: the thing being reached for was simply filed in the wrong place.
 * `command/` importing from `cli/` is the direction that already exists.
 *
 * The tour RENDERS; it does not run anything. So it knows the tour was asked for and the concept
 * was put in front of somebody, and nothing about whether they then looked, acted or proved. The
 * remaining three ONBOARD steps are observed by the daemon at the first look, act and verdict,
 * which is the only place they are a fact.
 */
export function tutorialShownSteps(): OnboardingStep[] {
  return (['tour_started', 'concept_shown'] as const).map((step) => ({
    phase: OnboardingPhase.ONBOARD,
    step,
    status: OnboardingStepStatus.COMPLETED,
  }));
}
