/**
 * Writes that share a body SHAPE and differ in body: the pair the salted fingerprint cannot
 * decide (#1521).
 *
 * Split out of `contradictions.ts` whole: that file crossed the 1000-line cap when this rule
 * landed, and rule 6 says split before adding. This file borrows only names
 * `contradictions.ts` already borrowed, so the coupling count in
 * `core-coupling-only-shrinks.test.ts` moves only by the split itself.
 */

import { ContradictionKind } from '@reticlehq/core';
import { isSteadyCadence } from './contradiction-evidence.js';
import type { OwnContradiction } from './contradiction-types.js';
import type { WriteIdentity } from './write-identity.js';

/** One mutating call to an endpoint, with the identity the record gave it. */
export interface TimedWrite {
  readonly t: number;
  readonly landed: boolean;
  readonly identity: WriteIdentity | undefined;
}

/**
 * The indistinguishable pairs among one endpoint's calls.
 *
 * A double submit whose second send restamps its body (a fresh client timestamp, request id
 * or idempotency key) has two different exact fingerprints, so the exact-identity grouping
 * in `contradictions.ts` reports nothing: the false green the salted fingerprint opened
 * (#1521). The pair is not a duplicate: the bodies differ. It is not a pass either: the
 * shape is the discriminator that grouped such pairs as one write before the salted hash,
 * and a restamped double submit is exactly what it cannot separate from two different
 * writes that share a shape. Report the pair as calls that could not be told apart. A pair
 * the exact grouping already reported as a duplicate (one exact group of two or more landed
 * calls inside the shape group) is not reported twice.
 */
export function findIndistinguishableWrites(
  calls: readonly TimedWrite[],
  label: string,
  related: boolean,
): OwnContradiction[] {
  const result: OwnContradiction[] = [];
  const byShape = new Map<string, typeof calls>();
  for (const call of calls) {
    const shapeKey = call.identity?.shapeKey;
    if (shapeKey === undefined) {
      continue;
    }
    byShape.set(shapeKey, [...(byShape.get(shapeKey) ?? []), call]);
  }
  for (const shapeCalls of byShape.values()) {
    if (shapeCalls.length < 2) {
      continue;
    }
    const exactKeys = new Set(shapeCalls.map((c) => c.identity?.key));
    if (exactKeys.size < 2) {
      continue;
    }
    const landedByKey = new Map<string, number>();
    for (const call of shapeCalls) {
      if (call.landed && call.identity !== undefined) {
        landedByKey.set(call.identity.key, (landedByKey.get(call.identity.key) ?? 0) + 1);
      }
    }
    if ([...landedByKey.values()].some((n) => 2 <= n)) {
      continue;
    }
    const landed = shapeCalls.filter((c) => c.landed).length;
    if (landed < 2) {
      continue;
    }
    if (isSteadyCadence(shapeCalls.map((c) => c.t))) {
      continue;
    }
    const count = String(shapeCalls.length);
    result.push({
      kind: related
        ? ContradictionKind.DUPLICATE_REQUEST_INDISTINGUISHABLE
        : ContradictionKind.DUPLICATE_REQUEST_INDISTINGUISHABLE_UNRELATED,
      claim: related ? 'one user action was performed' : 'the assertion did not name this endpoint',
      counter: 'these calls could not be told apart',
      detail:
        `${label} ×${count} — the bodies share a shape and differ in a value, ` +
        'so whether they were one write repeated or different writes could not be established',
    });
  }
  return result;
}
