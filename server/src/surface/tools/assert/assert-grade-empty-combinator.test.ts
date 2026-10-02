/**
 * Zero branches grade at the FLOOR, and the floor is `none` — not `presence`.
 *
 * `combine()`'s own doc comment has always said the right thing: "No branches proves nothing, so it
 * stays at the floor." The code returned `HonestyGrade.PRESENCE`, which is not the floor —
 * `HonestyGrade.NONE` is. The comment described the design and the code shipped one rung above it.
 *
 * That one rung is the whole defect. `VACUOUS_GRADE` fires on `HonestyGrade.NONE`, so an empty
 * combinator graded `presence` walked straight past the guard whose entire job is refusing a green
 * that rests on nothing, and reported `verified: "yes"`.
 *
 * The schema now refuses an empty combinator outright, so this can no longer arrive through the
 * documented door. This is the second defence and it is deliberate: the boundary stops it entering,
 * and the floor stops it counting if it ever reaches the evaluator another way — a predicate built
 * in TypeScript, a future caller that constructs rather than parses. A guard that only works when
 * the other guard works is one guard.
 */

import { describe, expect, it } from 'vitest';
import { HonestyGrade } from '@reticlehq/engine/evidence/honesty.js';
import type { Predicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { gradeOfPredicate } from './assert-grade.js';

describe('a combinator with no branches grades at the floor', () => {
  it('grades an empty allOf as none, so VACUOUS_GRADE can see it', () => {
    const empty = { kind: 'allOf', predicates: [] } as unknown as Predicate;
    expect(gradeOfPredicate(empty)).toBe(HonestyGrade.NONE);
  });

  it('grades an empty anyOf as none', () => {
    const empty = { kind: 'anyOf', predicates: [] } as unknown as Predicate;
    expect(gradeOfPredicate(empty)).toBe(HonestyGrade.NONE);
  });

  /** The change must not touch a combinator that actually has branches. */
  it('still takes the strongest branch of a real allOf', () => {
    const real = {
      kind: 'allOf',
      predicates: [
        { kind: 'element', query: { testid: 'toast' } },
        { kind: 'signal', name: 'saved' },
      ],
    } as unknown as Predicate;
    expect(gradeOfPredicate(real)).toBe(HonestyGrade.SIGNAL);
  });

  /** And an OR still takes the WEAKEST, because nothing records which branch greened. */
  it('still takes the weakest branch of a real anyOf', () => {
    const real = {
      kind: 'anyOf',
      predicates: [
        { kind: 'signal', name: 'saved' },
        { kind: 'element', query: { testid: 'toast' } },
      ],
    } as unknown as Predicate;
    expect(gradeOfPredicate(real)).toBe(HonestyGrade.PRESENCE);
  });
});
