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
  PredicateSchema,
  REQUEST_SHAPE_FIELD,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { declaredExpectations } from '../question/declared.js';

/** The same query posted twice, close together: a burst, not a poll. */
function readTwice(url: string, status = 200): ReticleEvent[] {
  return [10, 50].map(
    (t) =>
      ({
        type: EventType.NET_REQUEST,
        t,
        data: { method: 'POST', url, status, ok: true, [REQUEST_SHAPE_FIELD]: 'q1q2q3q4' },
      }) as unknown as ReticleEvent,
  );
}

/** The duplicate findings for `events` under a predicate, read the way the tools read it. */
function duplicatesUnder(events: ReticleEvent[], predicate: Record<string, unknown>): string[] {
  const declared = declaredExpectations(PredicateSchema.parse(predicate));
  return findContradictions(events, {
    actionSince: 0,
    namedNetUrls: declared.netUrls,
    repeatableNetUrls: declared.repeatableNetUrls,
  })
    .map((c) => c.kind)
    .filter((k) => k.startsWith('duplicate-request'));
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
      repeatableNetUrls: [{ urlContains: '/graphql' }],
    });
    const duplicates = found.filter((c) => c.kind === ContradictionKind.DUPLICATE_REQUEST);
    expect(duplicates.map((c) => c.detail)).toEqual([expect.stringContaining('/save')]);
  });
});

describe('net { repeatable: true } cannot excuse a write it does not name', () => {
  it('is refused on a clause with no urlContains, which would excuse every request', () => {
    for (const bare of [
      { kind: 'net', repeatable: true },
      { kind: 'net', method: 'POST', urlContains: '', repeatable: true },
      { kind: 'net', urlContains: '   ', repeatable: true },
    ]) {
      const parsed = PredicateSchema.safeParse(bare);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('needs a non-empty `urlContains`');
    }
    expect(
      PredicateSchema.safeParse({
        kind: 'allOf',
        predicates: [{ kind: 'net', repeatable: true }],
      }).success,
    ).toBe(false);
  });

  it('a bare repeatable never reaches the duplicate rule, so two identical writes stay a duplicate', () => {
    // The measured lever: two identical `POST /api/orders` 201s under `{ kind: "net", repeatable: true }`.
    const declared = declaredExpectations({ kind: PredicateKind.NET, repeatable: true });
    expect(declared.repeatableNetUrls).toEqual([]);
    const found = findContradictions(readTwice('https://app.test/api/orders', 201), {
      actionSince: 0,
      namedNetUrls: declared.netUrls,
      repeatableNetUrls: declared.repeatableNetUrls,
    }).map((c) => c.kind);
    expect(found).toContain(ContradictionKind.DUPLICATE_REQUEST);
  });

  it('a repeatable GET clause does not excuse POSTs to the same endpoint', () => {
    expect(
      duplicatesUnder(readTwice('https://app.test/api/orders', 201), {
        kind: 'allOf',
        predicates: [
          { kind: 'net', method: 'POST', urlContains: '/api/orders' },
          { kind: 'net', method: 'GET', urlContains: '/api', repeatable: true },
        ],
      }),
    ).toEqual([ContradictionKind.DUPLICATE_REQUEST]);
  });

  it('a repeatable POST clause on the read endpoint still excuses its reads', () => {
    expect(
      duplicatesUnder(readTwice('https://app.test/graphql'), {
        kind: 'net',
        method: 'POST',
        urlContains: '/graphql',
        repeatable: true,
      }),
    ).toEqual([]);
    expect(
      duplicatesUnder(readTwice('https://app.test/graphql'), {
        kind: 'net',
        method: 'post',
        urlContains: '/graphql',
        repeatable: true,
      }),
    ).toEqual([]);
  });

  it('matches the URL, not the method spelled into the label', () => {
    expect(
      duplicatesUnder(readTwice('https://app.test/api/orders', 201), {
        kind: 'net',
        urlContains: 'POST',
        repeatable: true,
      }),
    ).toEqual([ContradictionKind.DUPLICATE_REQUEST]);
  });
});
