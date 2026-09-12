import { z } from 'zod';
import { ChannelIdSchema, Grade } from './channel.js';

/**
 * The protocol's output, and the two things that must never be quietly merged into it.
 *
 * Four values, and the last two are why this specification exists. Every automation format in
 * common use has two, and the two it has are the two that let a verifier round its ignorance
 * towards good news.
 */
export const Verdict = {
  /** Proved. Requires independent, consequence-grade evidence over a cleanly closed window. */
  YES: 'yes',
  /** Disproved: the claim failed, or independent channels contradict each other. */
  NO: 'no',
  /**
   * Nobody could tell.
   *
   * Load-bearing, and must never collapse into either neighbour. "The capture was truncated so I
   * could not see" and "the application is broken" lead an actor to opposite next moves: one says
   * look again with better coverage, the other says go and fix something. Merging them
   * manufactures both false alarms and false confidence at once.
   */
  UNKNOWN: 'unknown',
  /**
   * Everything was watched, every rule ran, nothing was wrong -- and nothing was declared, so
   * there was nothing to prove.
   *
   * Distinct from `unknown`, which used to carry both this and "I could not see". They need
   * opposite responses: this one says DECLARE SOMETHING, the other says LOOK AGAIN. Two properties
   * keep it honest and both must be enforced rather than documented: it requires a cleanly closed
   * window, so it cannot be earned by returning early, and it is never `yes`, so it cannot be
   * mistaken for proof. Without the first it becomes the green-forever button that an
   * always-available "nothing was wrong" always becomes.
   */
  NO_FAULT: 'no-fault',
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

/** Why a verdict came out as it did. Open, because a reason list is an implementation's own. */
export const VerdictReasonSchema = z.string().min(1);

/**
 * Something worth knowing that nobody asked about.
 *
 * An assertion asks "did the thing we required happen?". An anomaly asks "did we find something
 * that matters?". It is the only part of this model that produces output the caller did not
 * request, and it is the part least dependent on knowing what kind of application this is -- which
 * makes it the piece most worth agreeing on across implementations.
 *
 * The kinds below are the DOMAIN-INDEPENDENT ones: each is a statement about two observations in
 * one window that cannot both be true, and each can be described without knowing whether the
 * subject is a web page, a service or a robot. An implementation will find kinds this list does
 * not name and should report them with an `x-` prefix; what it may not do is report a
 * disagreement between two actuation-derived channels as a fault. See `disagreementCanConvict`.
 */
export const AnomalyKind = {
  /** The subject moved forward while an operation in the same window failed. */
  ADVANCED_OVER_FAILURE: 'advanced-over-failure',
  /** The subject announced success while an operation in the same window failed. */
  CLAIMED_OVER_FAILURE: 'claimed-over-failure',
  /** An operation succeeded at the boundary and nothing in the subject moved. */
  EFFECT_DISCARDED: 'effect-discarded',
  /** The subject announced success and nothing anywhere corroborated it. */
  CLAIM_UNCORROBORATED: 'claim-uncorroborated',
  /** A transport-level success carrying a failure in its payload. */
  FAILURE_INSIDE_SUCCESS: 'failure-inside-success',
  /** A value came back at a different scale or type than it was sent. */
  VALUE_NOT_APPLIED: 'value-not-applied',
  /** The same mutating operation happened more than once for one action. */
  DUPLICATED_EFFECT: 'duplicated-effect',
  /** Two operations settled out of order and the later-displayed one is stale. */
  STALE_APPLIED: 'stale-applied',
  /** The action was delivered and no channel recorded anything at all. */
  NO_EFFECT: 'no-effect',
  /** The far side faulted and the subject blamed the actor. */
  FAULT_MISATTRIBUTED: 'fault-misattributed',
  /** Every observation belongs to a subject instance that has since been replaced. */
  EVIDENCE_SUPERSEDED: 'evidence-superseded',
  /** Every observation predates the round of edits under test. */
  EVIDENCE_PREDATES_EDIT: 'evidence-predates-edit',
} as const;
export type AnomalyKind = (typeof AnomalyKind)[keyof typeof AnomalyKind];

export const AnomalyKindSchema = z.union([
  z.nativeEnum(AnomalyKind),
  z
    .string()
    .regex(/^x-[a-z0-9-]+$/, 'an anomaly this specification does not name must start with x-'),
]);

/**
 * What an anomaly is entitled to do to a verdict.
 *
 * Three tiers, because two were not enough and the gap had a measured cost. An application that
 * polled on an interval could produce no verdict at all: writes the claim never mentioned counted
 * against every assertion, and correct verifications came back `unknown` behind traffic nobody
 * had asked about.
 */
export const AnomalyTier = {
  /** Positively observed, on independent channels. May force `no`. */
  OBSERVED: 'observed',
  /**
   * Inferred from ABSENCE inside a window whose end the verifier chose.
   *
   * "The thing I expected had not happened yet when I stopped looking" is not "it did not happen",
   * and a verifier that treats them alike overrules consequence evidence with a timing
   * observation. May downgrade to `unknown`; may never force `no`.
   */
  ABSENCE_DERIVED: 'absence-derived',
  /** True, worth reporting, and not about the claim. Decides nothing. */
  ADVISORY: 'advisory',
} as const;
export type AnomalyTier = (typeof AnomalyTier)[keyof typeof AnomalyTier];

export const AnomalySchema = z.object({
  kind: AnomalyKindSchema,
  tier: z.nativeEnum(AnomalyTier),
  /** What the subject appeared to claim. */
  claim: z.string().min(1),
  /** What contradicts it. */
  counter: z.string().min(1),
  /** The two channels set against each other, so independence can be re-checked by a reader. */
  between: z.tuple([ChannelIdSchema, ChannelIdSchema]),
  /** Evidence ids behind it. */
  evidence: z.array(z.string()).default([]),
});
export type Anomaly = z.infer<typeof AnomalySchema>;

/**
 * A verdict about one claim.
 *
 * `supersedes` is what makes the whole model sound over time. A judgement made across a bounded
 * stretch of time and presented as final is a claim the evidence does not support -- the evidence
 * supports "this is what it looked like by the time we stopped watching". Late evidence lands: a
 * write accepted for later processing succeeds, an operation still in flight settles.
 *
 * A revision NEVER edits the verdict it replaces. It is a new verdict that cites the old one, and
 * both are kept, so a reader can see that the first answer was given, when it changed, and why.
 * "We always knew" stops being expressible, which is the point.
 */
export const VerdictRecordSchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(1),
  window: z.string().min(1),
  verdict: z.nativeEnum(Verdict),
  /** What bought the answer. Absent on `unknown` and `no-fault`, where nothing did. */
  grade: z.nativeEnum(Grade).optional(),
  reasons: z.array(VerdictReasonSchema).default([]),
  evidence: z.array(z.string()).default([]),
  anomalies: z.array(AnomalySchema).default([]),
  /** The earlier verdict this replaces, as `<runId>#<verdictId>`. Present only on a correction. */
  supersedes: z.string().optional(),
  at: z.number().int(),
});
export type VerdictRecord = z.infer<typeof VerdictRecordSchema>;

/** How a verdict cites another, so a correction points at something resolvable. */
export function citeVerdict(runId: string, verdictId: string): string {
  return `${runId}#${verdictId}`;
}

/**
 * A correction, as a new record that leaves the old one untouched.
 *
 * Carries the new reasons rather than appending to the old: those described what was known at the
 * time, and they are still there, on the verdict this one cites.
 */
export function reviseVerdict(
  earlier: VerdictRecord,
  earlierRunId: string,
  next: { id: string; verdict: Verdict; reasons: readonly string[]; at: number; grade?: Grade },
): VerdictRecord {
  return {
    id: next.id,
    claim: earlier.claim,
    window: earlier.window,
    verdict: next.verdict,
    ...(next.grade === undefined ? {} : { grade: next.grade }),
    reasons: [...next.reasons],
    evidence: [],
    anomalies: [],
    supersedes: citeVerdict(earlierRunId, earlier.id),
    at: next.at,
  };
}
