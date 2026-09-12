import { z } from 'zod';
import { ActionSchema } from './realm-surface.js';
import { AssertionSchema } from './intent.js';
import { ProvenanceClass, ProvenanceSchema } from './evidence.js';
import { Verdict } from './verdict.js';

/**
 * What a verification leaves behind: a route worth walking again, a failure worth acting on, and
 * a belief worth holding at arm's length.
 *
 * This is the layer that compounds, and it is also the layer that can quietly destroy the
 * protocol's whole reason for existing. A verification system that learns what "normal" looks like
 * and then treats normal as correct has become a very expensive way of confirming that yesterday
 * happened again. That is not a hypothetical risk; it is the standard failure of every invariant
 * miner since Daikon, and the standard defence -- "the operator reviews the invariants" -- does not
 * survive contact with a system that generates thousands of them.
 *
 * So memory is in this specification, and it is fenced. The fence is one rule, stated here,
 * enforced in code below, and required of every conformant implementation:
 *
 *   **A learned belief may never, by itself, produce a `yes`.**
 *
 * It may raise a question. It may direct attention. It may downgrade a verdict to `unknown`, which
 * is the honest thing an unproven suspicion does. It may become authoritative only by an act of
 * PROMOTION that a person or a specification performs -- never by repetition, never by a
 * confidence threshold, and never as a side effect of being right a lot.
 */

/**
 * A route that established a claim, recorded so it can be walked again without rediscovery.
 *
 * The economic case is real and the honest version of it is narrower than it is usually sold. A
 * recorded route replayed deterministically is far cheaper than a model rediscovering it, and the
 * comparison that matters is against a model, not against a compiled test suite somebody already
 * has -- against that, replay saves nothing and should not be sold as if it did.
 */
/**
 * The version of the OVP Flow Document GRAMMAR — not of any one document's contents.
 *
 * A document says which grammar it was written against so a reader can tell "this predates the
 * field you are looking for" from "this omitted it". Published as a constant because the schema
 * ships as JSON for implementations that never load this package's code, and a number they have to
 * infer from prose is a number they will get wrong.
 */
export const OVP_FLOW_GRAMMAR_VERSION = 1;

export const FlowSchema = z.object({
  name: z.string().min(1),
  /** Which grammar this document was written against — see `OVP_FLOW_GRAMMAR_VERSION`. */
  version: z.number().int().positive(),
  /**
   * Where the subject must be before step 1, interpreted and validated BY THE REALM.
   *
   * This was a web route, which quietly assumed every subject has URLs. A level in a game, a home
   * position on a rig, a signed-in container on a phone and a seeded schema on a service are all the
   * same idea and none of them is a path. So the document carries an opaque value and the protocol
   * does not look inside it — a protocol that parsed this would be a protocol with an opinion about
   * what a subject is, which is the opinion it exists not to have.
   *
   * Absent means "start from wherever the subject already is", which is a real and common answer.
   */
  startState: z.unknown().optional(),
  /** The claim this route was recorded as establishing. */
  claim: z.string().min(1),
  steps: z.array(ActionSchema),
  /** What must hold at the end for a replay to count as having reproduced the original. */
  expects: z.array(AssertionSchema).default([]),
  /**
   * Whether a replay may repair a step whose target has moved.
   *
   * Off by default and deliberately so: a self-healing replay that rebinds to a different element
   * and passes has reported on a route nobody took.
   */
  mayRebind: z.boolean().default(false),
});
export type Flow = z.infer<typeof FlowSchema>;

/**
 * What a failed verification hands back so the failure can be acted on.
 *
 * Evidence-driven, and the distinction is the whole value. Not "try something else", which is what
 * an actor does anyway, but "this claim failed because this evidence contradicts this assertion,
 * and here is where the responsible code is". A repair packet with no evidence pointer is a
 * suggestion, and an actor acting on suggestions is guessing with extra steps.
 */
export const RepairSchema = z.object({
  verdict: z.string().min(1),
  /** What was supposed to be true. */
  expected: z.string().min(1),
  /** What was observed instead. */
  actual: z.string().min(1),
  /** Evidence ids that establish the contradiction. At least one, or this is a guess. */
  evidence: z.array(z.string()).min(1),
  /** Where the responsible code is, when the realm can map it. */
  location: z
    .object({ file: z.string(), line: z.number().int().optional(), symbol: z.string().optional() })
    .optional(),
  /** A concrete instruction, for an actor that will act rather than read. */
  instruction: z.string().min(1),
});
export type Repair = z.infer<typeof RepairSchema>;

/** What kind of thing memory is holding. */
export const BeliefKind = {
  /** A relationship expected to hold: after X, Y follows within N. */
  INVARIANT: 'invariant',
  /** A way this subject has failed before. */
  FAILURE_MODE: 'failure-mode',
  /** A channel that has repeatedly been unobservable here. */
  GAP: 'gap',
  /** A repair that worked, or did not. */
  REPAIR_OUTCOME: 'repair-outcome',
} as const;
export type BeliefKind = (typeof BeliefKind)[keyof typeof BeliefKind];

/**
 * One thing the system believes about a subject, and on whose authority.
 *
 * `provenance.class` is not metadata here. It is the field that decides what this belief is
 * allowed to do, and `beliefCanProve` is the enforcement.
 */
export const BeliefSchema = z.object({
  id: z.string().min(1),
  kind: z.nativeEnum(BeliefKind),
  statement: z.string().min(1),
  provenance: ProvenanceSchema,
  /** How many verifications contributed. Evidence of repetition, never evidence of truth. */
  observations: z.number().int().nonnegative().default(0),
  /** Set only when a person or specification promoted this. See `promoteBelief`. */
  promotedBy: z.string().optional(),
  promotedAt: z.number().int().optional(),
});
export type Belief = z.infer<typeof BeliefSchema>;

/**
 * May this belief, on its own, establish a claim?
 *
 * The fence. A `learned` belief returns false no matter how many observations back it and no
 * matter how high its confidence, because repetition is not authority and a threshold is just a
 * number somebody picked. The only route from `learned` to provable is `promoteBelief`.
 */
export function beliefCanProve(belief: Belief): boolean {
  return belief.provenance.class !== ProvenanceClass.LEARNED;
}

/**
 * The strongest verdict a belief may produce on its own.
 *
 * A learned belief that appears violated is a REASON TO LOOK, not a finding. It returns `unknown`,
 * which is the honest verdict for a suspicion, and which sends an actor to gather evidence rather
 * than to fix something that may not be broken.
 */
export function strongestVerdictFrom(belief: Belief): Verdict {
  return beliefCanProve(belief) ? Verdict.NO : Verdict.UNKNOWN;
}

/**
 * Promote a learned belief to authoritative, by an act somebody is named for.
 *
 * Deliberately requires an author and deliberately cannot be called with a confidence, a count or
 * a threshold. If promotion could be automated it would be, and then the fence would be a comment.
 * Everything about this signature exists to make the automated version awkward to write.
 */
export function promoteBelief(belief: Belief, by: string, at: number): Belief {
  if (by.trim().length === 0) {
    throw new Error(
      'a belief can only be promoted by somebody who can be named: promotion is the one step ' +
        'between "we have noticed this a lot" and "this is a rule", and an anonymous promotion is ' +
        'the automated promotion this fence exists to prevent',
    );
  }
  return {
    ...belief,
    provenance: { ...belief.provenance, class: ProvenanceClass.AUTHORITATIVE },
    promotedBy: by,
    promotedAt: at,
  };
}
