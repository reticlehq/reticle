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
const seen = { look: false, act: false, verdict: false, driven: false };

/** A tool call the daemon just ran. Called from the dispatch chokepoint, which sees every one. */
export function noteOnboardingFirst(toolName: string): void {
  if (!seen.look && LOOK_TOOLS.has(toolName)) {
    seen.look = true;
    void reportOnboardingStep({
      phase: OnboardingPhase.ONBOARD,
      step: 'first_look',
      status: OnboardingStepStatus.COMPLETED,
    });
  }
}

/**
 * The first ACTION of this run, and the fact that this install has been driven at all.
 *
 * Called from the dispatch chokepoint's own action branch rather than matched on a tool name here.
 * The name test was `toolName === ReticleTool.ACT`, on the worry that `act_and_wait` would report
 * one call as two different firsts — and the worry was backwards: this server's instructions tell
 * every agent to PREFER `act_and_wait`, so the step measured the tool we ask agents not to use and
 * the ONBOARD phase read as "looked, never acted, then produced a verdict from nowhere". A call that
 * both acts and proves genuinely did both, and `first_act` and `first_verdict` are different steps
 * in different positions of the same funnel.
 *
 * Taking the decision from the caller is what keeps it from happening again: the dispatcher already
 * owns the set of tools that drive the page, and a second copy of that set here is a second thing to
 * update when a fourth driving tool arrives.
 */
export function noteActed(args: Record<string, unknown>): void {
  // A hover changes nothing and is not an action anybody drove.
  if (args['action'] === ActionType.HOVER) return;
  noteDriven();
  if (seen.act) return;
  seen.act = true;
  void reportOnboardingStep({
    phase: OnboardingPhase.ONBOARD,
    step: 'first_act',
    status: OnboardingStepStatus.COMPLETED,
  });
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

/**
 * Something was driven on the user's own project — the FIRST_RUN rung between "the install worked"
 * and "they used it".
 *
 * Declared in the closed step list from the day the funnel was written and emitted by no code at
 * all, so any chart rendered over the declared order showed a 100% cliff in the middle of the
 * conversion story. It reads as catastrophe and was an unwired emit.
 *
 * Reported from `noteActed`, so the one place that knows a tool drove the page is the one place that
 * says so. That includes a drive we run on the user's behalf, whose own actions cross the same
 * chokepoint — a drive that is refused before its first action drove nothing and says nothing.
 */
export function noteDriven(): void {
  if (seen.driven) return;
  seen.driven = true;
  void reportOnboardingStep({
    phase: OnboardingPhase.FIRST_RUN,
    step: 'driven',
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
  seen.driven = false;
}
