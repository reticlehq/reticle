import { PredicateKind, compareSourceClauses } from '@reticlehq/core';
import type { Predicate } from './predicate-schema.js';

/**
 * Did the caller's predicate ask about registered state?
 *
 * Walks composites, because `allOf[{net}, {state}]` asks about state exactly as much as a bare
 * `{state}` does — and the gap that reveals is the same one either way.
 *
 * Lives here rather than at a call site because both the act path and the assert path need it, and
 * two walkers over one predicate tree is two chances to disagree about what counts as asking.
 *
 * Named `predicate-asks` rather than `predicate-shape` because `predicate-shape.test.ts` already
 * exists and is about something else entirely — a file that reads as the subject of an unrelated
 * test is a half-hour somebody loses later.
 */
export function declaresState(predicate: Predicate): boolean {
  if (predicate.kind === PredicateKind.STATE) return true;
  if (predicate.kind === PredicateKind.ALL_OF || predicate.kind === PredicateKind.ANY_OF) {
    return predicate.predicates.some(declaresState);
  }
  if (predicate.kind === PredicateKind.NOT) return declaresState(predicate.predicate);
  if (predicate.kind === PredicateKind.COMPARE) {
    return compareSourceClauses(predicate).some(declaresState);
  }
  return false;
}

/**
 * Does the caller's predicate judge the DOM — an `element` or `text` clause anywhere in the tree?
 *
 * The question behind it is where a verdict is allowed to point. A DOM predicate has its own locus:
 * the element it matched, whose `file:line` the descriptor already carries. A `signal`/`net`/`state`
 * failure has none — there is no node for "the request was never made" — and that is the one case
 * where the verdict borrows the last driven control's line, because the handler that should have
 * fired lives there.
 *
 * Walks composites for the same reason `declaresState` does: `allOf[{element}, {signal}]` looked at
 * the DOM exactly as much as a bare `{element}` did.
 */
export function declaresDom(predicate: Predicate): boolean {
  if (predicate.kind === PredicateKind.ELEMENT || predicate.kind === PredicateKind.TEXT)
    return true;
  if (predicate.kind === PredicateKind.ALL_OF || predicate.kind === PredicateKind.ANY_OF) {
    return predicate.predicates.some(declaresDom);
  }
  if (predicate.kind === PredicateKind.NOT) return declaresDom(predicate.predicate);
  if (predicate.kind === PredicateKind.COMPARE) {
    return compareSourceClauses(predicate).some(declaresDom);
  }
  return false;
}
