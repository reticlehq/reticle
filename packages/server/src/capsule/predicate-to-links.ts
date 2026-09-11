import { ConsequenceKind, PredicateKind } from '@reticlehq/core';
import type { Predicate } from '../events/predicate.js';
import type { ExpectedLink } from './divergence.js';

/**
 * Convert a mustHold predicate into the ordered ExpectedLinks the divergence capsule walks. Only the
 * consequence kinds (signal/net/state) become links — a presence check (element/text) can't diverge in a
 * dataflow sense. allOf/anyOf flatten in order; other kinds are skipped. Pure; feeds the capsule on red.
 */
export function predicateToExpectedLinks(predicate: Predicate): ExpectedLink[] {
  switch (predicate.kind) {
    case PredicateKind.SIGNAL:
      return predicate.name === undefined
        ? []
        : [{ kind: ConsequenceKind.SIGNAL, name: predicate.name }];
    case PredicateKind.NET:
      return predicate.urlContains === undefined
        ? []
        : [
            {
              kind: ConsequenceKind.NET,
              urlContains: predicate.urlContains,
              ...(predicate.status === undefined ? {} : { status: predicate.status }),
            },
          ];
    case PredicateKind.STATE: {
      const name = predicate.store ?? predicate.path;
      return [{ kind: ConsequenceKind.STATE, name }];
    }
    case PredicateKind.ALL_OF:
    case PredicateKind.ANY_OF:
      return predicate.predicates.flatMap(predicateToExpectedLinks);
    default:
      return [];
  }
}
