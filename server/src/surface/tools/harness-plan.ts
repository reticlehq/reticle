/**
 * What a drive is FOR, decided before it starts and read out of `.reticle` rather than the app.
 *
 * The driver used to open its eyes on a page and pick whatever looked interesting. That makes every
 * run start from zero: it re-drives journeys that are already saved, and it has no idea which
 * declared intent nobody has ever tested. Both are the same missing input — the project's own
 * record of what it claims to do and what has been proved about it.
 *
 * `.reticle` already holds that. `buildDomainModel` reads `.reticle/flows/` and
 * `.reticle/contract.json` and answers with every saved flow, the consequence that MUST hold for
 * each one, and the GAPS: signals and testids the app DECLARED that no flow asserts. So the plan is
 * derivable with no browser, no model and no source code — which is the order this product argues
 * for everywhere else and did not follow here.
 *
 * Two kinds of step, and the split is the whole economics:
 *
 *   REPLAY  a journey that is already recorded. Deterministic, no model in the loop, a few hundred
 *           tokens. Anything already covered belongs here and must never be re-driven.
 *   DRIVE   a gap. A model is worth paying for exactly where nothing is proved yet.
 *
 * Nothing here calls a model. The plan is the deterministic half, and the model's only job is to
 * choose among steps somebody already decided were worth taking.
 */

import type { DomainModel } from '@/judgement/domain/domain-model.js';

export const PlanStepKind = {
  /** Already recorded: replay it deterministically instead of paying a model to rediscover it. */
  REPLAY: 'replay',
  /** Declared but never proved: this is what a drive is actually for. */
  DRIVE: 'drive',
} as const;
export type PlanStepKind = (typeof PlanStepKind)[keyof typeof PlanStepKind];

export interface PlanStep {
  kind: PlanStepKind;
  /** The flow to replay, or a short label for the gap to cover. */
  target: string;
  /**
   * WHY this step is in the plan, in the project's own words.
   *
   * For a replay it is the consequence that must hold — the flow's `mustHold`, which is the thing
   * that stops being true when the feature breaks. For a drive it is the declared intent nobody has
   * tested. Carried because the model choosing between steps should be reading intent, not a list
   * of names it has no way to rank.
   */
  why: string;
}

export interface HarnessPlan {
  steps: readonly PlanStep[];
  /** One line an agent or a human can read, derived rather than narrated. */
  summary: string;
}

/**
 * How many untested declarations become drive steps.
 *
 * A contract can declare hundreds of testids, and a plan longer than the step budget is not a plan,
 * it is a list. Capped so the drive spends its budget on the front of a ranked queue rather than
 * spreading itself across everything and finishing none of it.
 */
const MAX_DRIVE_STEPS = 12;

/**
 * How many recorded journeys become replay steps.
 *
 * A project with seventy-four flows produced a seventy-four-step plan, which went into the tool
 * result AND the standing instruction — thousands of tokens spent, every turn, listing work the
 * drive had no budget to do. The whole argument for reading `.reticle` first is spending less, and
 * an uncapped plan spends more.
 *
 * `reticle_domain` caps its own per-flow detail at 25 for the same measured reason. Ranked before
 * cutting, so what survives is what is worth replaying first rather than whatever was listed first.
 */
const MAX_REPLAY_STEPS = 15;

/** Signals first: a declared signal is a stronger statement of intent than a testid. */
function driveSteps(domain: DomainModel): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const signal of domain.gaps.declaredUntestedSignals) {
    steps.push({
      kind: PlanStepKind.DRIVE,
      target: signal,
      why: `the app declares the signal "${signal}" and no saved flow asserts it`,
    });
  }
  for (const testid of domain.gaps.declaredUntestedTestids) {
    steps.push({
      kind: PlanStepKind.DRIVE,
      target: testid,
      why: `the app declares the control "${testid}" and no saved flow exercises it`,
    });
  }
  return steps.slice(0, MAX_DRIVE_STEPS);
}

/**
 * Replay steps, worst-risk first when there is run history to rank by.
 *
 * A flow that asserts nothing is listed too, and says so: replaying it proves very little, and the
 * honest plan admits that rather than counting it as coverage.
 */
function replaySteps(domain: DomainModel): PlanStep[] {
  const byName = new Map(domain.flows.map((flow) => [flow.name, flow]));
  const ordered =
    0 === domain.riskRanked.length
      ? domain.flows.map((flow) => flow.name)
      : [
          ...domain.riskRanked,
          ...domain.flows.map((f) => f.name).filter((name) => !domain.riskRanked.includes(name)),
        ];

  /*
   * Flows that assert a real consequence come first, whatever the run history says.
   *
   * A flow with no `mustHold` passes as long as its steps still run, so replaying one proves close
   * to nothing — and when the plan has to be cut, proving nothing is the first thing to give up.
   */
  const ranked = [
    ...ordered.filter((name) => byName.get(name)?.mustHold !== undefined),
    ...ordered.filter((name) => byName.get(name)?.mustHold === undefined),
  ];

  const steps: PlanStep[] = [];
  for (const name of ranked) {
    const flow = byName.get(name);
    if (flow === undefined) continue;
    steps.push({
      kind: PlanStepKind.REPLAY,
      target: name,
      why:
        flow.mustHold === undefined
          ? `already recorded, but it asserts no consequence — replaying it proves only that the steps still run`
          : `already recorded; it must still hold: ${flow.mustHold}`,
    });
  }
  return steps.slice(0, MAX_REPLAY_STEPS);
}

/**
 * Build the plan.
 *
 * Replays come first, always. They are the cheap half and they establish what is still true before
 * any model is paid to explore what is not yet known — and a regression found by a replay is found
 * for a few hundred tokens rather than a few hundred thousand.
 */
export function buildHarnessPlan(domain: DomainModel): HarnessPlan {
  const replays = replaySteps(domain);
  const drives = driveSteps(domain);
  const steps = [...replays, ...drives];

  // Counted over EVERYTHING, then listed up to the cap — the same split `reticle_domain` uses, so a
  // capped listing never quietly becomes a smaller analysis.
  const totalRecorded = domain.flows.length;
  const totalGaps =
    domain.gaps.declaredUntestedSignals.length + domain.gaps.declaredUntestedTestids.length;
  const omitted = totalRecorded - replays.length + (totalGaps - drives.length);

  const summary =
    0 === steps.length
      ? 'Nothing is recorded and nothing is declared: there is no plan to follow, so drive the app to find out what it does.'
      : `${String(totalRecorded)} recorded journey(s) and ${String(totalGaps)} untested declaration(s); the plan lists the ${String(steps.length)} worth doing first${0 === omitted ? '' : `, omitting ${String(omitted)}`}.`;
  return { steps, summary };
}

/**
 * The plan as the model reads it.
 *
 * Intent first and names second, because a model ranking "what next" against a list of identifiers
 * is guessing, and ranking against what the project says each one is FOR is not. The kind is stated
 * so it can prefer finishing the cheap deterministic half before spending itself on the rest.
 */
export function planAsText(plan: HarnessPlan): string {
  if (0 === plan.steps.length) return 'PLAN: none — nothing recorded, nothing declared.';
  const lines = plan.steps.map(
    (step, index) => ` ${String(index + 1)}. [${step.kind}] ${step.target} — ${step.why}`,
  );
  return `PLAN (from .reticle, not from the source):\n${lines.join('\n')}`;
}
