/**
 * `reticle verify --results-json <file>`: the run, one line per journey, for a machine to read.
 *
 * The rendered report is for a person, and a CI step that has to post per-journey verdicts somewhere
 * else would otherwise scrape it. Three words only, the engine's own: a skipped flow is `unknown`,
 * never rounded up to `yes`, and the run is `yes` only when every journey is.
 */
import {
  RunFlowStatus,
  VerdictStatus,
  Verified,
  type ReticleVerificationRun,
} from '@reticlehq/core';

type JourneyVerdict = typeof Verified.YES | typeof Verified.NO | typeof Verified.UNKNOWN;

/**
 * How many steps passed, failed, or were never judged. `unknown` is a step the replay never
 * reached or could not decide; it stays in the total, so an undecided step never raises a score.
 */
export interface StepCounts {
  passed: number;
  failed: number;
  unknown: number;
}

export interface VerifyResults {
  verdict: JourneyVerdict;
  /** `runId` is the run the journey came from, set only when that run reached the platform. */
  results: {
    journey: string;
    verdict: JourneyVerdict;
    reason?: string;
    runId?: string;
    steps: StepCounts;
  }[];
  /** All journeys together. `value` is passed / total, absent when there is no step at all. */
  score: StepCounts & { total: number; value?: number };
}

/**
 * One journey's steps. `planned` is the flow file's step count, when the caller could read it:
 * without it, a replay that stopped at step 2 of 10 would look like a 2-step journey. Replay adds a
 * `success` step for a flow with a success oracle, so the total is the larger of the two.
 */
function stepCounts(flow: ReticleVerificationRun['flows'][number], planned?: number): StepCounts {
  const judged = flow.stepResults ?? [];
  const passed = judged.filter((s) => s.ok && s.drift === undefined).length;
  const failed = judged.length - passed;
  const total = Math.max(planned ?? flow.steps, judged.length);
  return { passed, failed, unknown: total - judged.length };
}

function journeyVerdict(status: RunFlowStatus): JourneyVerdict {
  if (RunFlowStatus.FAIL === status) return Verified.NO;
  // A heal is consequence-verified before it is reported, so it proves as much as a pass.
  if (RunFlowStatus.PASS === status || RunFlowStatus.HEALED === status) return Verified.YES;
  return Verified.UNKNOWN;
}

/**
 * `pushed`: the run reached the platform, so its id resolves there and the results name it.
 * `planned`: each flow file's step count, by journey name (see `stepCounts`).
 */
export function verifyResults(
  run: ReticleVerificationRun,
  pushed = false,
  planned: ReadonlyMap<string, number> = new Map(),
): VerifyResults {
  const results = run.flows.map((flow) => ({
    journey: flow.name,
    verdict: journeyVerdict(flow.status),
    ...(flow.failureReason === undefined ? {} : { reason: flow.failureReason }),
    ...(pushed ? { runId: run.runId } : {}),
    steps: stepCounts(flow, planned.get(flow.name)),
  }));
  const sum = (key: keyof StepCounts): number => results.reduce((n, r) => n + r.steps[key], 0);
  const passed = sum('passed');
  const total = passed + sum('failed') + sum('unknown');
  const score = {
    passed,
    failed: sum('failed'),
    unknown: sum('unknown'),
    total,
    ...(0 === total ? {} : { value: passed / total }),
  };
  const verdict = results.some((r) => Verified.NO === r.verdict)
    ? Verified.NO
    : VerdictStatus.PASS === run.verdict.status && results.every((r) => Verified.YES === r.verdict)
      ? Verified.YES
      : Verified.UNKNOWN;
  return { verdict, results, score };
}
