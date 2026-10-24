import {
  ActionType,
  NextStepOffered,
  OnboardingPhase,
  OnboardingStepStatus,
  ReticleTool,
  type OnboardingStep,
} from '@reticlehq/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { reportOnboardingStep } from './onboarding-funnel.js';
import { getTelemetry, projectFingerprint } from './telemetry.js';

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
 *
 * And once per MACHINE + PROJECT on top of that: the flags only know this process, and a daemon
 * restarts many times a day, so each first re-fired on every start. `claimFirstEver` answers from
 * disk; the true first carries `firstEver: true`, and a home that cannot be written falls back to
 * once per process without the flag.
 */
const seen = { look: false, act: false, verdict: false, driven: false, verdictProduced: false };

/** Report `step` once per process, and only if this machine + project has never reported it. */
export function reportFirstStep(step: OnboardingStep): void {
  const ever = claimFirstEver(step.step);
  if (FirstEver.SEEN === ever) return;
  void reportOnboardingStep({ ...step, ...(FirstEver.FIRST === ever ? { firstEver: true } : {}) });
}

/** A successful page read. The dispatcher calls this after excluding refusals and pauses. */
export function noteOnboardingFirst(toolName: string): void {
  if (!seen.look && LOOK_TOOLS.has(toolName)) {
    seen.look = true;
    reportFirstStep({
      phase: OnboardingPhase.ONBOARD,
      step: 'first_look',
      status: OnboardingStepStatus.COMPLETED,
    });
  }
}

/**
 * The first ACTION of this run, and the fact that this install has been driven at all.
 *
 * Called after the dispatcher observes a dispatched action, rather than on an attempted call.
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
  reportFirstStep({
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
  reportFirstStep({
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
  reportFirstStep({
    phase: OnboardingPhase.FIRST_RUN,
    step: 'driven',
    status: OnboardingStepStatus.COMPLETED,
  });
}

/**
 * The FIRST_RUN rung "a verdict was produced". Once per machine + project, with how long the call
 * took: it fired on every verdict, so a busy session put hundreds of first-run steps in the funnel.
 */
export function noteVerdictProduced(elapsedMs: number): void {
  if (seen.verdictProduced) return;
  seen.verdictProduced = true;
  reportFirstStep({
    phase: OnboardingPhase.FIRST_RUN,
    step: 'verdict_produced',
    status: OnboardingStepStatus.COMPLETED,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
  });
}

/**
 * Did the agent do the next step that the first session call offered?
 *
 * The first session call in an unwired project changes no file. It offers a step: the lease, or
 * the consent question for `init`. The offer is reported `started`. The agent's next call reports
 * it `completed`, with `nextFollowed`. The lease is followed when that call acquires a lease. The
 * consent question is followed when the project is wired by then (the user agreed and `init` ran).
 */
interface PendingOffer {
  offered: NextStepOffered;
  wired: () => boolean;
}

// ponytail: one pending offer per daemon, not per agent. Two agents in two unwired projects at the
// same moment can close each other's offer. Key it by attach id if the data shows that case.
let pending: PendingOffer | undefined;

const STEP = 'next_step_offered';
const ACQUIRE = 'acquire';

export function noteNextStepOffered(offered: NextStepOffered, wired: () => boolean): void {
  pending = { offered, wired };
  void reportOnboardingStep({
    phase: OnboardingPhase.FIRST_RUN,
    step: STEP,
    status: OnboardingStepStatus.STARTED,
    offered,
  });
}

/** Called on every agent call, before its handler runs. Closes an open offer, once. */
export function noteNextCall(tool: string, args: Record<string, unknown>): void {
  const offer = pending;
  if (offer === undefined) {
    return;
  }
  pending = undefined;
  void reportOnboardingStep({
    phase: OnboardingPhase.FIRST_RUN,
    step: STEP,
    status: OnboardingStepStatus.COMPLETED,
    offered: offer.offered,
    nextFollowed: followed(offer, tool, args),
  });
}

function followed(offer: PendingOffer, tool: string, args: Record<string, unknown>): boolean {
  if (NextStepOffered.LEASE === offer.offered) {
    return (
      ReticleTool.LEASE_ACQUIRE === tool ||
      (ReticleTool.LEASE === tool && ACQUIRE === args['action'])
    );
  }
  return offer.wired();
}

/** Tests only: forget an open offer. */
export function resetNextStepOffered(): void {
  pending = undefined;
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
  seen.verdictProduced = false;
}

/**
 * Has this machine + project EVER crossed this onboarding step?
 *
 * The in-memory flags in `onboarding-firsts.ts` and `app-instrumented.ts` answer "this daemon
 * process", and a daemon restarts many times a day, so every "first" step re-fired on every start.
 * The answer is kept on disk instead, as one empty marker file per step under the state home:
 * `~/.reticle/firsts/<projectId>/<step>`. The exclusive create (`wx`) IS the claim, so two daemons
 * racing for the same first cannot both win, and nothing is ever rewritten in place.
 *
 * Only while telemetry is ENABLED: a disabled emitter has nothing to report and must leave nothing
 * behind on disk.
 */
export const FirstEver = {
  /** This call claimed it: the true first on this machine + project. */
  FIRST: 'first',
  /** Claimed before, by this process or an earlier one. Report nothing. */
  SEEN: 'seen',
  /** The state home cannot be written. Report per process, and never claim a first. */
  UNKNOWN: 'unknown',
} as const;
export type FirstEver = (typeof FirstEver)[keyof typeof FirstEver];

const DEFAULT_DIR = join(homedir(), '.reticle', 'firsts');
const EEXIST = 'EEXIST';

let override: { dir: string; projectId: string } | undefined;
let cachedProjectId: string | undefined;

/** Tests only: a state home and project of the test's own. `undefined` restores the default. */
export function setFirstEverDir(dir: string | undefined, projectId = 'test-project'): void {
  override = dir === undefined ? undefined : { dir, projectId };
}

const currentProjectId = (): string =>
  (cachedProjectId ??= projectFingerprint(process.cwd()).projectId);

export function claimFirstEver(step: string, projectId?: string): FirstEver {
  if (override === undefined && !getTelemetry().enabled) return FirstEver.UNKNOWN;
  try {
    const dir = join(
      override?.dir ?? DEFAULT_DIR,
      projectId ?? override?.projectId ?? currentProjectId(),
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, step), '', { flag: 'wx' });
    return FirstEver.FIRST;
  } catch (error) {
    const code =
      'object' === typeof error && null !== error ? (error as { code?: unknown }).code : undefined;
    return EEXIST === code ? FirstEver.SEEN : FirstEver.UNKNOWN;
  }
}
