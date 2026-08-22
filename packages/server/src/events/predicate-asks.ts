import { PredicateKind } from '@reticlehq/core';
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
 * NOT in `predicate-schema.ts` next to `predicateFieldsFor`, where it would otherwise belong: five
 * open contributor PRs are queued on that file and on `predicate-eval.ts`, and a one-function import
 * is not worth handing five people a conflict. Named `predicate-asks` rather than `predicate-shape`
 * because `predicate-shape.test.ts` already exists and is about something else entirely — a file
 * that reads as the subject of an unrelated test is a half-hour somebody loses later.
 */
export function declaresState(predicate: Predicate): boolean {
  if (predicate.kind === PredicateKind.STATE) return true;
  if (predicate.kind === PredicateKind.ALL_OF || predicate.kind === PredicateKind.ANY_OF) {
    return predicate.predicates.some(declaresState);
  }
  if (predicate.kind === PredicateKind.NOT) return declaresState(predicate.predicate);
  return false;
}
