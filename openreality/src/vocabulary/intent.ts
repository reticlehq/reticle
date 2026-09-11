import { z } from 'zod';
import { ChannelIdSchema } from './channel.js';

/**
 * The Intent Plane: why somebody acted, and what was supposed to become true.
 *
 * The distinction this plane exists for is between what somebody MEANT and what a verifier can
 * SEE. An agent building a feature knows what it is for -- which user does what, what should
 * become true, what the failure looks like. That knowledge lives in its context, and then the turn
 * ends. Later, a different turn drives the application holding the surface, the diff, and no
 * intent, so it asserts what it can see rather than what was meant. What it can see is almost
 * always weaker, and that gap is where a false green comes from.
 *
 * So intent is captured as PROSE, early, and bound to something checkable LATER or never. The two
 * properties move in opposite directions: fidelity is highest the moment somebody asks and decays
 * with every restatement, while bindability starts near zero -- there is no route, no element and
 * often no code yet -- and rises as the code appears. Demanding a predicate at declare time
 * collects mechanisms, which is what assertions already are. Waiting until verify time collects a
 * re-derivation, which is the weak artifact this exists to replace.
 *
 * An intent that stays `declared` and never becomes `bound` is not a failure. It is the most
 * interesting row in the ledger, because it names something a team meant that nothing can prove.
 */

/** Where an intent came from, because an intent with no author cannot be questioned. */
export const IntentOrigin = {
  USER: 'user',
  DEVELOPER: 'developer',
  AGENT: 'agent',
  SYSTEM: 'system',
  WORKFLOW: 'workflow',
  /** Inferred from context rather than stated. Weakest, and must say so. */
  DERIVED: 'derived',
} as const;
export type IntentOrigin = (typeof IntentOrigin)[keyof typeof IntentOrigin];

/** How far an intent has got towards being checkable. */
export const IntentStatus = {
  /** Said in prose. Nothing can verify it yet. */
  DECLARED: 'declared',
  /** Attached to at least one claim something can evaluate. */
  BOUND: 'bound',
  /** Deliberately closed without ever being bound, with a reason. */
  ABANDONED: 'abandoned',
} as const;
export type IntentStatus = (typeof IntentStatus)[keyof typeof IntentStatus];

export const IntentSchema = z
  .object({
    id: z.string().min(1),
    /** Prose, and mandatory. The thing whose fidelity decays -- captured before it does. */
    statement: z.string().min(1),
    origin: z.nativeEnum(IntentOrigin),
    status: z.nativeEnum(IntentStatus),
    /** Claim ids this intent was bound to. Empty while `declared`. */
    claims: z.array(z.string()).default([]),
    /**
     * Why it was abandoned. Required WHEN abandoned, and refused blank; omitted in every other
     * state, because only giving up owes an explanation.
     *
     * This said "Required in spirit" and was enforced by nothing, so `{ status: 'abandoned' }`
     * validated -- and SPEC.md is not written in spirit here, it says the reason MUST be
     * recorded, on the grounds that "`abandoned` exists so that giving up is a decision somebody
     * wrote down rather than a row that quietly stopped moving". A bare abandonment IS that row.
     */
    abandonedBecause: z.string().optional(),
    declaredAt: z.number().int().optional(),
  })
  .refine(
    (i) => i.status !== IntentStatus.ABANDONED || (i.abandonedBecause ?? '').trim().length > 0,
    {
      message:
        'an abandoned intent must record why: the reason is what makes giving up a decision ' +
        'somebody wrote down rather than a row that quietly stopped moving.',
      path: ['abandonedBecause'],
    },
  );
export type Intent = z.infer<typeof IntentSchema>;

/**
 * When the claim was written down, relative to the action.
 *
 * The whole difference between a check and a rationalisation, and the reason it is a field rather
 * than an assumption. Afterwards, anything that happened can be described as what you meant; a
 * claim made in advance can only be met or missed. Pre-registration is the oldest known defence
 * against exactly this, and no test format records it.
 */
export const Declaration = {
  /** Written down before the action was taken. Required for a `yes` at consequence grade. */
  BEFORE_ACTION: 'before-action',
  /** Written down after. Admissible, and can never buy a proof. */
  AFTER_ACTION: 'after-action',
} as const;
export type Declaration = (typeof Declaration)[keyof typeof Declaration];

/**
 * One condition, evaluated against one or more channels.
 *
 * Assertions are lower-level than claims: "the fan is physically off" is a claim, and
 * `motor.rpm == 0` is an assertion that helps establish it. The protocol does not standardise a
 * predicate language -- that is a realm's business and a place where a spec ages badly. It
 * standardises which CHANNELS an assertion reads, because that is what decides whether the
 * assertion can prove anything.
 */
export const AssertionSchema = z.object({
  id: z.string().min(1),
  /** What is being asserted, in whatever language the realm accepts. Opaque here on purpose. */
  predicate: z.unknown(),
  /** A human-readable rendering, so a verdict is legible to somebody without the realm. */
  reads: z.string().min(1),
  /** The channels answering this requires. The rule in channel.ts is applied to these. */
  channels: z.array(ChannelIdSchema).min(1),
});
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * A state of the world that is supposed to hold.
 *
 * Claims are what verification actually evaluates. One intent decomposes into several, and the
 * decomposition is where honesty enters: "turn off the fan" becomes "the command was received",
 * "the reported state is off", "the motor has stopped", "nothing else changed" -- and those four
 * have wildly different evidence available. Collapsing them into one boolean is how a smart-home
 * API's cheerful `success: true` comes to mean a fan that is still spinning.
 */
export const ClaimSchema = z.object({
  id: z.string().min(1),
  /** The intent this serves, when there is one. A claim may stand alone. */
  intent: z.string().optional(),
  /** What is supposed to be true, in prose. */
  statement: z.string().min(1),
  declaredAt: z.nativeEnum(Declaration),
  /** The conditions that would establish it. */
  assertions: z.array(AssertionSchema).default([]),
});
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Something that must remain true THROUGHOUT, rather than become true at the end.
 *
 * The difference matters and is not decorative. "The invoice exists" is a claim, checked once.
 * "No payment is duplicated" is a constraint, and a verification that only looks at the end state
 * cannot see it being violated in the middle. A constraint is therefore evaluated over the whole
 * window, and a verifier that cannot do that must declare it as a blind spot rather than report
 * the constraint as held.
 */
export const ConstraintSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  /** The condition, in the realm's language. */
  predicate: z.unknown(),
  channels: z.array(ChannelIdSchema).min(1),
  /**
   * What a violation means.
   *
   * `blocking` stops the run: a duplicated payment is not something to note and continue past.
   * `advisory` is recorded and decides nothing.
   */
  severity: z.enum(['blocking', 'advisory']).default('blocking'),
});
export type Constraint = z.infer<typeof ConstraintSchema>;
