import { z } from 'zod';
import { SubjectRefSchema } from './subject.js';

/**
 * The Reality Plane: what an actor may do, what it did, and over what stretch of time anybody
 * looked.
 *
 * The design decision worth defending here is that an actor does not get universal verbs. There is
 * no `click()` in this protocol. A robot does not click, a database has no pointer, and a service
 * has no screen -- so a protocol built on the browser's vocabulary is a browser protocol wearing a
 * general name, and every non-web realm that implements it has to lie about what it is doing.
 *
 * Instead a realm DECLARES its capabilities and refuses everything else.
 */

/**
 * Something this realm allows an actor to do.
 *
 * Declared, not assumed. The declaration is what makes refusal possible, and refusal is the main
 * defence against a false pass: an implementation that quietly does something ADJACENT to what was
 * asked produces a result that looks like evidence and is not. Measured here: a locator resolving
 * to the element beside the button, driven, reported as a clean green over a page where nothing
 * had happened. A refusal is a worse experience and a better answer.
 */
export const CapabilitySchema = z.object({
  /** Stable name. Domain language, not interface language: `turn_off_device`, not `tap`. */
  name: z.string().min(1),
  /** What it does, for an actor deciding whether this is the thing it wants. */
  meaning: z.string().min(1),
  /** Parameter shape, as JSON Schema. Absent means it takes nothing. */
  parameters: z.unknown().optional(),
  /**
   * Whether performing this can change the world.
   *
   * Read-only capabilities are safe to retry and safe to run for discovery. A verifier that cannot
   * tell them apart either refuses to explore or explores destructively.
   */
  mutating: z.boolean(),
});
export type Capability = z.infer<typeof CapabilitySchema>;

/** Why a realm would not do what it was asked. */
export const RefusalReason = {
  /** The capability was never declared. */
  UNDECLARED: 'undeclared',
  /** Declared, but this realm cannot honestly drive this particular target. */
  UNSUPPORTED: 'unsupported',
  /** The target could not be found. */
  UNRESOLVED: 'unresolved',
  /** Found, and not in a state that can accept this. */
  UNAVAILABLE: 'unavailable',
  /** Refused on purpose: destructive, and not authorised for this run. */
  GUARDED: 'guarded',
  /** The arguments were malformed. Never substitute a default and proceed. */
  MALFORMED: 'malformed',
} as const;
export type RefusalReason = (typeof RefusalReason)[keyof typeof RefusalReason];

/**
 * A handle for something in the realm, and how a person would recognise it.
 *
 * The thing a driver could not get. An action names a `target`, and the specification never said
 * where a target comes from -- so a caller holding "the button called Pay" had no defined route
 * to something `act` would accept. Found by writing a driver against the interface: every action
 * it attempted was refused, correctly, because a selector a person writes is not a handle.
 *
 * `ref` is OPAQUE and belongs to the realm. It is not a selector, not a path, and not stable
 * across subjects -- a realm may mint it however it likes and is entitled to reject one that has
 * gone stale, which is the behaviour that makes a handle safer than a selector: a selector
 * silently matches something else when the thing moves, and a handle refuses.
 *
 * `describes` is for the human reading the verdict afterwards, and for nothing else. Deciding
 * anything from it would be matching on prose.
 */
export const HandleSchema = z.object({
  /** Opaque, realm-minted, and the only thing an action should be given. */
  ref: z.string().min(1),
  /** How a person would recognise this, for a verdict somebody has to read. */
  describes: z.string().min(1),
  /** Where it is, when the realm has a meaningful answer. */
  at: z.string().optional(),
});
export type Handle = z.infer<typeof HandleSchema>;

export const ActionSchema = z.object({
  id: z.string().min(1),
  /** Who or what performed it. */
  actor: z.string().min(1),
  capability: z.string().min(1),
  /** The handle's `ref`. See `HandleSchema`: a selector is not a target. */
  target: z.string().optional(),
  parameters: z.unknown().optional(),
  at: z.number().int(),
});
export type Action = z.infer<typeof ActionSchema>;

/**
 * What came back from performing an action.
 *
 * A RECEIPT, and never a verdict. This is the single most important shape in the Reality Plane and
 * the one an implementer is most likely to get wrong, because every UI automation library in
 * existence returns something that looks like success.
 *
 * `dispatched: true` says the action was delivered. It says nothing whatever about whether
 * anything happened, and a realm that conflates them has become the thing under test grading its
 * own work. The protocol forbids a realm from returning a verdict at all; this is the shape it
 * returns instead.
 */
export const ActionReceiptSchema = z.object({
  action: z.string().min(1),
  /** Was the action delivered to the realm? Not "did it work". */
  dispatched: z.boolean(),
  /** Set when it was NOT dispatched. A receipt with neither is malformed. */
  refused: z.object({ reason: z.nativeEnum(RefusalReason), detail: z.string().min(1) }).optional(),
  /** The subject as it was at dispatch, so late evidence can be checked for staleness. */
  subject: SubjectRefSchema,
  at: z.number().int(),
});
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;

/**
 * How a realm decides that it has finished looking.
 *
 * The generalisation this protocol most needed and the place a web-shaped design leaks. Quiescence
 * -- "wait until it all goes quiet" -- is ONE close condition, not the concept. A game never goes
 * quiet. A service's truth arrives after the acknowledgement. A robot settles physically and then
 * a separate sensor confirms it.
 *
 * So the close condition belongs to the REALM, and the engine that adjudicates must not assume any
 * particular one. An engine that hard-codes quiescence has excluded every asynchronous domain from
 * the protocol while appearing to support them.
 */
export const CloseCondition = {
  /** Nothing has happened for long enough that the realm considers the effect complete. */
  QUIESCENCE: 'quiescence',
  /** A specific number of frames or ticks elapsed. */
  TICKS: 'ticks',
  /** The far side acknowledged, and a reconciliation deadline has not yet passed. */
  ACK: 'ack',
  /** A named event the realm was waiting for arrived. */
  SIGNAL: 'signal',
  /** Physical motion stopped and an independent sensor agreed. */
  SETTLED_PHYSICAL: 'settled-physical',
  /** The budget ran out before any of the above. Never a clean close. */
  BUDGET_EXHAUSTED: 'budget-exhausted',
} as const;
export type CloseCondition = (typeof CloseCondition)[keyof typeof CloseCondition];

/**
 * The bounded stretch of time an observation belongs to.
 *
 * A window is not an implementation detail. An observation with no window cannot be argued with:
 * "the request went out" is not checkable unless you can say when, and relative to what. So every
 * observation belongs to a window, and any verdict built from observations is a claim about that
 * window and no other.
 *
 * `closedBy: budget-exhausted` is the one value that must never be silently treated as a clean
 * close. Measured here: an implementation exited at 492ms of an 8000ms budget and reported
 * `unknown` -- it had not spent the time it was given, and the honest answer was still available.
 */
export const WindowSchema = z.object({
  id: z.string().min(1),
  openedAt: z.number().int(),
  closedAt: z.number().int().optional(),
  budgetMs: z.number().int().positive(),
  /** What the realm was waiting for. */
  closes: z.nativeEnum(CloseCondition),
  /** What actually ended it. Differs from `closes` exactly when something went wrong. */
  closedBy: z.nativeEnum(CloseCondition).optional(),
  /** The subject this window was opened against. */
  subject: SubjectRefSchema,
});
export type Window = z.infer<typeof WindowSchema>;

/** Did this window end the way it meant to? A budget-exhausted close cannot support a proof. */
export function closedCleanly(window: Window): boolean {
  return (
    window.closedAt !== undefined &&
    window.closedBy !== undefined &&
    window.closedBy !== CloseCondition.BUDGET_EXHAUSTED
  );
}
