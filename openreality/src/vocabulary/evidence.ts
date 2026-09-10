import { z } from 'zod';
import { ChannelIdSchema, Grade, Independence } from './channel.js';
import { SubjectRefSchema } from './subject.js';

/**
 * What was seen, why it should be believed, and what could not be seen at all.
 *
 * The chain here is deliberately three links and not one:
 *
 *   Observation  -- something a channel reported
 *   Provenance   -- how it was obtained, and how far that can be trusted
 *   Evidence     -- an observation whose provenance is sufficient to bear on a claim
 *
 * Collapsing them is the ordinary mistake. A test report says "expected X, got Y" and the reader
 * supplies the provenance from imagination. That works while there is one channel and one process;
 * it stops working the moment a verifier holds a screen, a store, a network log and a sensor, and
 * has to say which of them is entitled to overrule the others.
 *
 * The third piece, COVERAGE, is the one with no prior art anywhere: every other verification
 * format in existence is silent about its own blind spots. A verdict that cannot say what it could
 * not see is indistinguishable from a verdict that saw everything, and those are the two facts a
 * reader most needs to tell apart.
 */

export const ObservationSchema = z.object({
  id: z.string().min(1),
  /** Which window it belongs to. An observation with no window is not checkable. */
  window: z.string().min(1),
  channel: ChannelIdSchema,
  /** When, on the realm's clock. */
  at: z.number().int(),
  /** What was seen. Opaque: the protocol does not standardise a realm's payloads. */
  value: z.unknown(),
  /** A human-readable rendering, so a verdict is legible without the realm. */
  summary: z.string().min(1),
});
export type Observation = z.infer<typeof ObservationSchema>;

/**
 * How much authority a piece of information carries.
 *
 * These four exist to stop the system poisoning itself once it starts learning, and the ordering
 * is normative. A pattern noticed a hundred times is still a pattern noticed a hundred times; it
 * is not a rule the world has agreed to. See `memory.ts`, where the consequence is enforced.
 */
export const ProvenanceClass = {
  /** Stated by something entitled to state it: a specification, a contract, an operator. */
  AUTHORITATIVE: 'authoritative',
  /** Computed from authoritative inputs by a rule somebody wrote down. */
  DERIVED: 'derived',
  /** Seen, this time, by an observer. The ordinary case. */
  OBSERVED: 'observed',
  /** Inferred from repetition. Probabilistic, and never on its own sufficient. */
  LEARNED: 'learned',
} as const;
export type ProvenanceClass = (typeof ProvenanceClass)[keyof typeof ProvenanceClass];

/** How strongly each class may bear on a verdict, ascending. Used to compare, never to add up. */
const AUTHORITY_ORDER: Record<ProvenanceClass, number> = {
  [ProvenanceClass.LEARNED]: 0,
  [ProvenanceClass.OBSERVED]: 1,
  [ProvenanceClass.DERIVED]: 2,
  [ProvenanceClass.AUTHORITATIVE]: 3,
};

export const ProvenanceSchema = z.object({
  class: z.nativeEnum(ProvenanceClass),
  /** What produced it: an adapter, an instrument, a person, a model. Named, not described. */
  source: z.string().min(1),
  /** How it was obtained, so a reader can judge it without trusting the source's word. */
  method: z.string().min(1),
  /** The subject it was obtained from. */
  subject: SubjectRefSchema,
  at: z.number().int(),
  /**
   * Only meaningful for `learned`, where it is required.
   *
   * A confidence on an OBSERVED fact is a category error -- either the observer saw it or it did
   * not observe it -- and attaching one is how a probabilistic gloss gets applied to a hard fact.
   */
  confidence: z.number().min(0).max(1).optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * An observation that is entitled to bear on a claim.
 *
 * The two fields beyond the observation itself are the whole point. `independence` says whether
 * this could have been caused by the action it is being offered as evidence for; `grade` says what
 * it is worth if it was not. An implementation that omits them has produced an observation and
 * called it evidence.
 */
export const EvidenceSchema = z.object({
  observation: ObservationSchema,
  provenance: ProvenanceSchema,
  /** Carried from the channel's declaration, so a verdict can be re-checked without the realm. */
  independence: z.nativeEnum(Independence),
  grade: z.nativeEnum(Grade),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Is this evidence allowed to establish something the same action caused? */
export function canSupportConsequence(evidence: Evidence): boolean {
  return (
    evidence.independence === Independence.INDEPENDENT &&
    evidence.grade === Grade.CONSEQUENCE &&
    evidence.provenance.class !== ProvenanceClass.LEARNED
  );
}

/** Which of two pieces of evidence carries more authority. Ties return the first. */
export function moreAuthoritative(a: Evidence, b: Evidence): Evidence {
  const left = AUTHORITY_ORDER[a.provenance.class as ProvenanceClass];
  const right = AUTHORITY_ORDER[b.provenance.class as ProvenanceClass];
  return right > left ? b : a;
}

/** Why a verifier could not see something. Open: a realm knows blind spots this list does not. */
export const BlindSpotKind = {
  /** A channel exists here and this implementation does not observe it. */
  CHANNEL_UNOBSERVED: 'channel-unobserved',
  /** Part of the subject is in a context this observer cannot enter. */
  BOUNDARY_UNCROSSABLE: 'boundary-uncrossable',
  /** The record was capped and older entries were dropped. */
  BUFFER_TRUNCATED: 'buffer-truncated',
  /** Content was withheld deliberately: a secret, a redaction. */
  REDACTED: 'redacted',
  /** The window closed while something was still outstanding. */
  STILL_IN_FLIGHT: 'still-in-flight',
  /** The consequence happened somewhere this observer cannot follow. */
  EFFECT_ELSEWHERE: 'effect-elsewhere',
} as const;
export type BlindSpotKind = (typeof BlindSpotKind)[keyof typeof BlindSpotKind];

/**
 * One thing that could not be seen.
 *
 * `impeaching` is the field that makes this useful rather than decorative. Most blind spots are
 * irrelevant to most claims: not watching `storage` costs nothing when the claim reads `net`. A
 * blind spot is impeaching when it falls on a channel the claim actually needed -- and only then
 * must it prevent a `yes`.
 *
 * Without the distinction, an honest implementation that declares many blind spots would be
 * punished for its honesty and would learn to declare fewer.
 */
export const BlindSpotSchema = z.object({
  kind: z.nativeEnum(BlindSpotKind),
  channel: ChannelIdSchema.optional(),
  detail: z.string().min(1),
  /** Does this fall on evidence the claim under test required? */
  impeaching: z.boolean(),
  /** What the operator could do about it, when there is something. */
  remedy: z.string().optional(),
});
export type BlindSpot = z.infer<typeof BlindSpotSchema>;

export const CoverageSchema = z.object({
  window: z.string().min(1),
  /** Channels actually watched for this window. */
  observed: z.array(ChannelIdSchema),
  /**
   * What was not seen.
   *
   * An EMPTY array is a positive claim that nothing was hidden. Absence of the whole field means
   * nobody looked, and those are different facts. An implementation that cannot enumerate its
   * blind spots must omit the field rather than send `[]`.
   */
  blindSpots: z.array(BlindSpotSchema),
});
export type Coverage = z.infer<typeof CoverageSchema>;

/** Does anything in this coverage fall on evidence the claim needed? */
export function isImpeached(coverage: Coverage): boolean {
  return coverage.blindSpots.some((spot) => spot.impeaching);
}
