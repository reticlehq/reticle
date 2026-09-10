import { z } from 'zod';
import { ChannelDescriptorSchema } from './channel.js';
import { ClaimSchema, ConstraintSchema, IntentSchema } from './intent.js';
import { ActionReceiptSchema, ActionSchema, WindowSchema } from './realm-surface.js';
import { CoverageSchema, EvidenceSchema } from './evidence.js';
import { AnomalySchema, Verdict, type VerdictRecord, VerdictRecordSchema } from './verdict.js';
import { RepairSchema } from './memory.js';
import { SubjectRefSchema } from './subject.js';

/** The version of this specification an artifact was produced under. */
export const OVP_VERSION = '1.0' as const;

/**
 * One complete verification, as a document somebody who has never heard of the producer can read.
 *
 * This is what crosses the wire, lands in CI, and gets attached to a deploy. Everything above is
 * the vocabulary; this is the sentence.
 *
 * The four properties that distinguish it from every test report that exists, and the reason a
 * consumer would prefer it:
 *
 *   - every claim records whether it was declared BEFORE the action, so a check can be told from
 *     a rationalisation;
 *   - every `yes` records the GRADE that bought it, so a cheap green cannot pass for a dear one;
 *   - every verdict carries the COVERAGE it was reached under, so the reader learns what the
 *     verifier could not see rather than assuming it saw everything;
 *   - every subject carries an EPOCH, so evidence about code that has since been rewritten cannot
 *     answer for code that replaced it.
 *
 * A reader who checks nothing else should check those four.
 */
export const VerificationRunSchema = z.object({
  ovp: z.literal(OVP_VERSION),
  id: z.string().min(1),
  /** Who produced this, and what they claim to implement. */
  verifier: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    /** The conformance profile this implementation earned. See registry.ts. */
    profile: z.string().optional(),
  }),
  subject: SubjectRefSchema,
  /** What this implementation declared it could observe. The first assertion it makes. */
  channels: z.array(ChannelDescriptorSchema),

  intents: z.array(IntentSchema).default([]),
  claims: z.array(ClaimSchema).default([]),
  constraints: z.array(ConstraintSchema).default([]),

  actions: z.array(ActionSchema).default([]),
  receipts: z.array(ActionReceiptSchema).default([]),
  windows: z.array(WindowSchema).default([]),

  evidence: z.array(EvidenceSchema).default([]),
  coverage: z.array(CoverageSchema).default([]),
  anomalies: z.array(AnomalySchema).default([]),

  verdicts: z.array(VerdictRecordSchema).default([]),
  repairs: z.array(RepairSchema).default([]),

  startedAt: z.number().int(),
  endedAt: z.number().int(),
});
export type VerificationRun = z.infer<typeof VerificationRunSchema>;

/**
 * The run's summary over its verdicts.
 *
 * A different question from a verdict, and so deliberately a different word for each value: no
 * single claim can be `partial`, and a run of nothing but undetermined claims is not a pass. The
 * two vocabularies exist so that nobody uses one where the other belongs, which is how `partial`
 * reaches a reader who was only ever told about four verdicts.
 */
export const RunOutcome = {
  /** Everything decided was proved. */
  PASS: 'pass',
  /** Something was disproved, or a blocking constraint was violated. */
  FAIL: 'fail',
  /** Some proved, some did not. */
  PARTIAL: 'partial',
  /** Nothing was proved either way. NOT a pass. */
  UNKNOWN: 'unknown',
} as const;
export type RunOutcome = (typeof RunOutcome)[keyof typeof RunOutcome];

/**
 * The outcome, computed rather than asserted.
 *
 * A function and not a field, because a producer that can write its own summary can write a
 * summary its verdicts do not support -- and that is the one lie this artifact must not be able
 * to tell. A consumer recomputes this and compares; a mismatch is grounds to reject the document.
 *
 * `unknown` and `no-fault` count towards NEITHER side. That is what those words mean, and a run of
 * nothing but them therefore reaches `unknown` rather than `pass` -- which is the whole reason
 * they survive into the artifact instead of being dropped at its door.
 */
export function outcomeOf(run: VerificationRun): RunOutcome {
  const proved = run.verdicts.filter((v) => v.verdict === Verdict.YES).length;
  const disproved = run.verdicts.filter((v) => v.verdict === Verdict.NO).length;
  if (disproved > 0 && proved > 0) return RunOutcome.PARTIAL;
  if (disproved > 0) return RunOutcome.FAIL;
  if (proved > 0) return RunOutcome.PASS;
  return RunOutcome.UNKNOWN;
}

/**
 * Verdicts that no later record has replaced.
 *
 * A run may contain a verdict and its correction. A reader that counts both has counted one claim
 * twice, and a reader that takes the first has taken the answer that was known to be wrong.
 */
export function standingVerdicts(run: VerificationRun): readonly VerdictRecord[] {
  const replaced = new Set(
    run.verdicts.map((v) => v.supersedes).filter((s): s is string => s !== undefined),
  );
  return run.verdicts.filter((v) => !replaced.has(`${run.id}#${v.id}`));
}
