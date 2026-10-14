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

export interface VerifyResults {
  verdict: JourneyVerdict;
  /** `runId` is the run the journey came from, set only when that run reached the platform. */
  results: { journey: string; verdict: JourneyVerdict; reason?: string; runId?: string }[];
}

function journeyVerdict(status: RunFlowStatus): JourneyVerdict {
  if (RunFlowStatus.FAIL === status) return Verified.NO;
  // A heal is consequence-verified before it is reported, so it proves as much as a pass.
  if (RunFlowStatus.PASS === status || RunFlowStatus.HEALED === status) return Verified.YES;
  return Verified.UNKNOWN;
}

/** `pushed`: the run reached the platform, so its id resolves there and the results name it. */
export function verifyResults(run: ReticleVerificationRun, pushed = false): VerifyResults {
  const results = run.flows.map((flow) => ({
    journey: flow.name,
    verdict: journeyVerdict(flow.status),
    ...(flow.failureReason === undefined ? {} : { reason: flow.failureReason }),
    ...(pushed ? { runId: run.runId } : {}),
  }));
  const verdict = results.some((r) => Verified.NO === r.verdict)
    ? Verified.NO
    : VerdictStatus.PASS === run.verdict.status && results.every((r) => Verified.YES === r.verdict)
      ? Verified.YES
      : Verified.UNKNOWN;
  return { verdict, results };
}
