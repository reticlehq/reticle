/**
 * A verification "kind" is either a CONSEQUENCE — the app provably did something that a locator
 * healed to the WRONG element, or a stale render, cannot fake — or a mere PRESENCE check, which such
 * a wrong locator CAN still satisfy. The classification decides when "green" actually means the
 * feature worked.
 *
 * The vocabulary lives here because three separate graders depend on it (flow classification, ad-hoc
 * assert grading, flow-success compilation), and a contributor must not be able to strengthen one and
 * silently leave the others weaker.
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

export const CONSEQUENCE_KINDS: ReadonlySet<string> = new Set(Object.values(ConsequenceKind));
const PRESENCE_KINDS: ReadonlySet<string> = new Set(Object.values(PresenceKind));

/**
 * The kinds that grade a flow as PRESENCE-ONLY rather than assertion-free.
 *
 * `element` and `text` are the weak checks `PresenceKind` names. `route` joins them here and only
 * here: a route change is observed on a channel rather than queried from the DOM, so it is not a
 * presence check in the sense `isPresenceKind` means, but a route-only expect must still grade as
 * presence rather than falling through to `assertion-free` — which would be a permanent green
 * wearing an assertion.
 */
export const PRESENCE_GRADED: ReadonlySet<string> = new Set([
  ...PRESENCE_KINDS,
  PredicateKind.ROUTE,
]);

/** True when `kind` (a predicate/expect kind) asserts a consequence (signal/net/state). */
export function isConsequenceKind(kind: string): boolean {
  return CONSEQUENCE_KINDS.has(kind);
}

/** True when `kind` is a weak presence check (element/text). */
export function isPresenceKind(kind: string): boolean {
  return PRESENCE_KINDS.has(kind);
}

/**
 * One thing an app can be shown to have done, named in a way both sides agree on.
 *
 * Two separate parts of Reticle need this exact shape. The rules that decide a verdict produce it
 * when they read a declared consequence; the part that explains a red verdict walks it, step by
 * step, to say which link in the chain broke. Neither one owns it, so it lives here with the rest of
 * the shared vocabulary, and neither has to reach into the other to say the same thing.
 *
 * It is exactly `ConsequenceKind` spelled out, so the two can never drift apart.
 *
 * Examples:
 *   { kind: ConsequenceKind.SIGNAL, name: 'cart:updated' }
 *   { kind: ConsequenceKind.NET, urlContains: '/api/save', status: 200 }
 *   { kind: ConsequenceKind.STATE, name: 'cart.items' }
 */
export type ExpectedLink =
  | { kind: typeof ConsequenceKind.SIGNAL; name: string }
  | { kind: typeof ConsequenceKind.NET; urlContains: string; status?: number }
  | { kind: typeof ConsequenceKind.STATE; name: string };
