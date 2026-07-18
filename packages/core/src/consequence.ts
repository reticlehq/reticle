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

/** True when a FlowExpect checks ONLY element presence — no consequence field is set. */
export function flowExpectIsPresenceOnly(expect: FlowExpect | undefined): boolean {
  return expect !== undefined && expect.element !== undefined && !flowExpectHasConsequence(expect);
}
