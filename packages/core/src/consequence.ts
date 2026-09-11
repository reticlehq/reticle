import type { FlowExpect } from './flow-types.js';

/**
 * The product thesis, in one place: a verification "kind" is either a CONSEQUENCE (the app provably
 * did something a locator healed to the WRONG element, or a stale render, cannot fake) or a mere
 * PRESENCE check (which such a wrong locator CAN still satisfy). This classification is the moat —
 * it decides when "green" actually means the feature worked. It was implemented three times over
 * (flow classification, ad-hoc assert grading, flow-success compilation); keeping the vocabulary here
 * means a contributor can never strengthen one grader and silently leave the others weaker.
 */

/** Kinds whose satisfaction proves an observable outcome — a wrong/healed element cannot fake them. */
export const ConsequenceKind = {
  SIGNAL: 'signal',
  NET: 'net',
  STATE: 'state',
} as const;
export type ConsequenceKind = (typeof ConsequenceKind)[keyof typeof ConsequenceKind];

/** Kinds that only check presence — weak, because a healed-but-wrong locator can still satisfy them. */
export const PresenceKind = {
  ELEMENT: 'element',
  TEXT: 'text',
} as const;
export type PresenceKind = (typeof PresenceKind)[keyof typeof PresenceKind];

/**
 * Every predicate discriminant, in one place — the five graded above plus the ungraded rest.
 *
 * Composed from ConsequenceKind/PresenceKind rather than respelling them, which is the whole point:
 * these strings are what an agent types into `until:`/`expect:`, what zod discriminates on, and what
 * a dozen files across flows, capsules and oracles switch on. A second spelling of 'signal' is
 * exactly the drift this file exists to prevent, and a typo in a free-string branch is not a compile
 * error anywhere — it is a case that silently never matches.
 *
 * The remaining kinds are neither consequence nor presence: they observe context (route, console),
 * timing (animation, settled), or combine other predicates (allOf/anyOf/not).
 */
export const PredicateKind = {
  ELEMENT: PresenceKind.ELEMENT,
  TEXT: PresenceKind.TEXT,
  SIGNAL: ConsequenceKind.SIGNAL,
  NET: ConsequenceKind.NET,
  STATE: ConsequenceKind.STATE,
  ROUTE: 'route',
  CONSOLE: 'console',
  ANIMATION: 'animation',
  SETTLED: 'settled',
  ALL_OF: 'allOf',
  ANY_OF: 'anyOf',
  NOT: 'not',
} as const;
export type PredicateKind = (typeof PredicateKind)[keyof typeof PredicateKind];

const CONSEQUENCE_KINDS: ReadonlySet<string> = new Set(Object.values(ConsequenceKind));
const PRESENCE_KINDS: ReadonlySet<string> = new Set(Object.values(PresenceKind));

/** True when `kind` (a predicate/expect kind) asserts a consequence (signal/net/state). */
export function isConsequenceKind(kind: string): boolean {
  return CONSEQUENCE_KINDS.has(kind);
}

/** True when `kind` is a weak presence check (element/text). */
export function isPresenceKind(kind: string): boolean {
  return PRESENCE_KINDS.has(kind);
}

/** True when a FlowExpect asserts at least one consequence (any of the ConsequenceKind fields set). */
export function flowExpectHasConsequence(expect: FlowExpect | undefined): boolean {
  if (expect === undefined) return false;
  const fields = expect as Record<string, unknown>;
  for (const kind of CONSEQUENCE_KINDS) {
    if (fields[kind] !== undefined) return true;
  }
  return false;
}

/**
 * True when a FlowExpect checks ONLY presence — an element or rendered text, no consequence field.
 *
 * `text` counts here for the same reason `element` does, and leaving it out would have been the
 * expensive kind of omission: a text-only expect would have been neither a consequence nor
 * presence-only, so it would have fallen through to `assertion-free` — a permanent green wearing
 * an assertion (#811).
 */
export function flowExpectIsPresenceOnly(expect: FlowExpect | undefined): boolean {
  if (expect === undefined || flowExpectHasConsequence(expect)) return false;
  return expect.element !== undefined || expect.text !== undefined;
}
