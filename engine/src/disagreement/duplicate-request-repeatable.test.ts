/**
 * A read over POST, declared as one, is not a double submit (#1353).
 *
 * GraphQL queries, tRPC batches, query buses and read Server Actions all read over POST, and React
 * StrictMode runs the effect behind them twice in development. With a net clause naming such an
 * endpoint, the second identical read came back `duplicate-request` and the verdict `unknown`,
 * though nothing was written. `repeatable: true` on the clause says the endpoint reads; without it
 * the rule is unchanged.
 */
import { describe, it, expect } from 'vitest';
import {
  ContradictionKind,
  EventType,
  PredicateKind,
  REQUEST_SHAPE_FIELD,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { declaredExpectations } from '../question/declared.js';

/** The same query posted twice, close together: a burst, not a poll. */
function readTwice(url: string): ReticleEvent[] {
  return [10, 50].map(
    (t) =>
      ({
        type: EventType.NET_REQUEST,
        t,
        data: { method: 'POST', url, status: 200, ok: true, [REQUEST_SHAPE_FIELD]: 'q1q2q3q4' },
      }) as unknown as ReticleEvent,
  );
}

function verdictFor(urlContains: string, repeatable?: boolean): string[] {
  const declared = declaredExpectations({
    kind: PredicateKind.NET,
    urlContains,
    ...(repeatable === undefined ? {} : { repeatable }),
  });
  return findContradictions(readTwice('https://app.test/graphql'), {
    actionSince: 0,
    namedNetUrls: declared.netUrls,
    repeatableNetUrls: declared.repeatableNetUrls,
  })
    .map((c) => c.kind)
    .filter((k) => k.startsWith('duplicate-request'));
}

describe('net { repeatable: true }', () => {
  it('keeps two identical reads of a declared read endpoint out of duplicate-request', () => {
    expect(verdictFor('/graphql', true)).not.toContain(ContradictionKind.DUPLICATE_REQUEST);
    expect(verdictFor('/graphql', true)).not.toContain(
      ContradictionKind.DUPLICATE_REQUEST_UNRELATED,
    );
  });

  it('leaves the same pair a duplicate without the declaration', () => {
    expect(verdictFor('/graphql')).toEqual([ContradictionKind.DUPLICATE_REQUEST]);
    expect(verdictFor('/graphql', false)).toEqual([ContradictionKind.DUPLICATE_REQUEST]);
  });

  it('covers only the endpoint it names', () => {
    const events = [
      ...readTwice('https://app.test/graphql'),
      ...readTwice('https://app.test/save'),
    ];
    const found = findContradictions(events, {
      actionSince: 0,
      namedNetUrls: ['/graphql', '/save'],
      repeatableNetUrls: ['/graphql'],
    });
    const duplicates = found.filter((c) => c.kind === ContradictionKind.DUPLICATE_REQUEST);
    expect(duplicates.map((c) => c.detail)).toEqual([expect.stringContaining('/save')]);
  });
});
