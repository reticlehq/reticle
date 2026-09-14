import { ActionType, OnboardingPhase, OnboardingStepStatus, ReticleTool } from '@reticlehq/core';
import { reportOnboardingStep } from './onboarding-funnel.js';

/**
 * The onboarding steps only the DAEMON can answer, reported once each per run.
 *
 * `reticle tutorial` renders a page; it cannot know whether the reader then looked at their app,
 * drove it, or proved anything. Those three are facts here and assumptions anywhere else, so they
 * are observed at the moment they happen rather than claimed when the tour is printed.
 *
 * ONCE per daemon run, exactly like `reportAppInstrumented` and for the same reason: the question is
 * "did this install ever get past looking", which has one answer per run. A session that snapshots
 * forty times is not forty people learning to look.
 *
 * The flags are module state rather than per-session, because a person who tours in one tab and
 * drives in another has still only crossed each of these once.
 */
const seen = { look: false, act: false, verdict: false };

/** A tool call the daemon just ran. Called from the dispatch chokepoint, which sees every one. */
export function noteOnboardingFirst(toolName: string, args: Record<string, unknown>): void {
  if (!seen.look && LOOK_TOOLS.has(toolName)) {
    seen.look = true;
    void reportOnboardingStep({
      phase: OnboardingPhase.ONBOARD,
      step: 'first_look',
      status: OnboardingStepStatus.COMPLETED,
    });
  }
  // An ACT, not a verdict tool that happens to act: `act_and_wait` is counted below as the verdict
  // it produces, and counting it here too would report one call as two different firsts.
  if (!seen.act && toolName === ReticleTool.ACT && args['action'] !== ActionType.HOVER) {
    seen.act = true;
    void reportOnboardingStep({
      phase: OnboardingPhase.ONBOARD,
      step: 'first_act',
      status: OnboardingStepStatus.COMPLETED,
    });
  }
}

/**
 * The first verdict of this run.
 *
 * Separate from `noteOnboardingFirst` because a verdict is not a tool NAME — it is a result shape,
 * and only the site that already decided "this was a verification" can say so. Reported from there.
 */
export function noteFirstVerdict(): void {
  if (seen.verdict) return;
  seen.verdict = true;
  void reportOnboardingStep({
    phase: OnboardingPhase.ONBOARD,
    step: 'first_verdict',
    status: OnboardingStepStatus.COMPLETED,
  });
}

/** Looking: the tools that read the page without changing it. */
const LOOK_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.INSPECT,
  ReticleTool.LOOK,
]);

/** Arm again for the next daemon run — the tests' seam, mirroring resetAppInstrumented. */
export function resetOnboardingFirsts(): void {
  seen.look = false;
  seen.act = false;
  seen.verdict = false;
}
