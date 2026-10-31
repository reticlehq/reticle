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
import type { ScoredRunStep } from '@/judgement/runs/artifact/replay-mapping.js';

type JourneyVerdict = typeof Verified.YES | typeof Verified.NO | typeof Verified.UNKNOWN;

/**
 * How many steps passed, failed, or were never judged. `unknown` is a step the replay never
 * reached or could not decide; it stays in the total, so an undecided step never raises a score.
 */
export interface StepCounts {
  passed: number;
  failed: number;
  unknown: number;
  /**
   * Verdicts reached AFTER the journey's first failed step (`--sweep` goes on past it). They are not
   * in `passed` or `failed`, and they count as `unknown` in the score: a step is paid only when every
   * step before it passed. Absent when no step ran after a failure.
   */
  swept?: { passed: number; failed: number };
}

/**
 * The shape of the `--results-json` file. 1 had only `verdict` and `results`; 2 adds `steps` per
 * journey and the gated `score`. A consumer checks this before it reads a field that 1 did not have.
 */
export const RESULTS_SCHEMA_VERSION = 2;

export interface VerifyResults {
  schemaVersion: number;
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
  let passed = 0;
  let failed = 0;
  let judgedUnits = 0;
  let swept: { passed: number; failed: number } | undefined;
  for (const step of (flow.stepResults ?? []) as ScoredRunStep[]) {
    // A sequence counts its sub-steps; any other step counts once.
    const units = step.subSteps?.total ?? 1;
    judgedUnits += units;
    const ok = step.ok && step.drift === undefined;
    // Gated: once a step failed, later verdicts are reported apart and never paid.
    if (swept !== undefined) {
      if (ok) {
        swept.passed += units;
      } else {
        swept.passed += step.subSteps?.passed ?? 0;
        swept.failed += 1;
      }
      continue;
    }
    if (ok) {
      passed += units;
    } else {
      passed += step.subSteps?.passed ?? 0;
      failed += 1;
      swept = { passed: 0, failed: 0 };
    }
  }
  const total = Math.max(planned ?? flow.steps, judgedUnits);
  const counts: StepCounts = { passed, failed, unknown: total - passed - failed };
  if (swept !== undefined && swept.passed + swept.failed > 0) {
    counts.swept = swept;
  }
  return counts;
}

function journeyVerdict(status: RunFlowStatus): JourneyVerdict {
  if (RunFlowStatus.FAIL === status) {
    return Verified.NO;
  }
  // A heal is consequence-verified before it is reported, so it proves as much as a pass.
  if (RunFlowStatus.PASS === status || RunFlowStatus.HEALED === status) {
    return Verified.YES;
  }
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
  const sum = (key: 'passed' | 'failed' | 'unknown'): number =>
    results.reduce((n, r) => n + r.steps[key], 0);
  const passed = sum('passed');
  const total = passed + sum('failed') + sum('unknown');
  const score = {
    passed,
    failed: sum('failed'),
    unknown: sum('unknown'),
    total,
    ...(0 === total ? {} : { value: passed / total }),
  };
  let verdict: JourneyVerdict = Verified.UNKNOWN;
  if (results.some((r) => Verified.NO === r.verdict)) {
    verdict = Verified.NO;
  } else if (
    VerdictStatus.PASS === run.verdict.status &&
    results.every((r) => Verified.YES === r.verdict)
  ) {
    verdict = Verified.YES;
  }
  return { schemaVersion: RESULTS_SCHEMA_VERSION, verdict, results, score };
}
