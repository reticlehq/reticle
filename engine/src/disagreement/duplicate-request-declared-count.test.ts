/**
 * Writes the assertion counted are not a double submit (#2273).
 *
 * Two clicks on two checkboxes each saved with `POST /api/profile/notification-preferences` and the
 * same JSON shape. Asserted with `{ kind: "net", method: "POST", urlContains: "/notification-preferences",
 * count: 2 }`, the predicate passed but `duplicate-request` called it "one user action was
 * performed" and the verdict came back `unknown`. A `count: N` on the clause makes up to N landed
 * writes to that endpoint the declared consequence; a write past N is still reported.
 */
import { describe, it, expect } from 'vitest';
import {
  ContradictionKind,
  EventType,
  PredicateSchema,
  REQUEST_SHAPE_FIELD,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from './contradictions.js';
import { declaredExpectations } from '../question/declared.js';

const URL = 'https://app.test/api/profile/notification-preferences';

/** `times` saves of the same shape close together: a burst, not a poll. */
function saves(times: number, method = 'POST'): ReticleEvent[] {
  return Array.from(
    { length: times },
    (_, i) =>
      ({
        type: EventType.NET_REQUEST,
        t: 10 + i * 40,
        data: { method, url: URL, status: 200, ok: true, [REQUEST_SHAPE_FIELD]: 'p1p2p3p4' },
      }) as unknown as ReticleEvent,
  );
}

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

const counted = (count: number, extra: Record<string, unknown> = {}) => ({
  kind: 'net',
  method: 'POST',
  urlContains: '/notification-preferences',
  count,
  ...extra,
});

describe('writes the assertion counted', () => {
  it('are not a double submit when as many landed as it declared', () => {
    expect(duplicatesUnder(saves(2), counted(2))).toEqual([]);
  });

  it('are not a double submit when fewer than declared landed', () => {
    expect(duplicatesUnder(saves(2), counted(3))).toEqual([]);
  });

  it('still report a write past the declared count', () => {
    expect(duplicatesUnder(saves(3), counted(2))).toEqual([ContradictionKind.DUPLICATE_REQUEST]);
  });

  it('still report a double submit when the clause declared no count', () => {
    expect(
      duplicatesUnder(saves(2), {
        kind: 'net',
        method: 'POST',
        urlContains: '/notification-preferences',
      }),
    ).toEqual([ContradictionKind.DUPLICATE_REQUEST]);
  });

  it('do not excuse writes of another method', () => {
    expect(duplicatesUnder(saves(2, 'PUT'), counted(2))).toEqual([
      ContradictionKind.DUPLICATE_REQUEST,
    ]);
  });

  it('do not excuse writes to an endpoint the counted clause did not name', () => {
    expect(
      duplicatesUnder(saves(2), {
        kind: 'allOf',
        predicates: [
          { kind: 'net', method: 'POST', urlContains: '/notification-preferences' },
          { kind: 'net', method: 'POST', urlContains: '/billing', count: 2 },
        ],
      }),
    ).toEqual([ContradictionKind.DUPLICATE_REQUEST]);
  });
});
