/**
 * An element the window saw removed is absent, also beside a virtualized list.
 *
 * Reported from the field (#2176, split from #984): the agent closed a dialog and asserted
 * `{ testid: 'confirm-dialog', absent: true }`. The page also held a virtualized list, so the
 * absence blind spot made the verdict `unknown`. An unmounted row could hold the target, but the
 * window holds the target's own `dom.removed`: the element was on the page and it left.
 *
 * The blind-spot event carries a count and no container, so the engine cannot tell whether a target
 * is outside every virtualized container. Only the removal of the target itself lifts the blind spot,
 * and only when the removed node has a page-level role (a dialog, a landmark) that is never a row.
 *
 * The other direction stays caught: absent text of a row inside the virtualized list is `unknown`,
 * because a row that was never rendered could hold that text.
 */
import { describe, expect, it } from 'vitest';
import {
  BlindSpotKind,
  EventType,
  PredicateKind,
  QueryBy,
  Verified,
  type ReticleEvent,
} from '@reticlehq/core';
import { absenceBlindSpotNote } from './blind-spots.js';
import { decideVerified } from './verified.js';
import { HonestyGrade } from './honesty.js';

const DIALOG_TESTID = 'confirm-dialog';
const spots = [{ kind: BlindSpotKind.VIRTUALIZED_UNMOUNTED, count: 19 }];

let seq = 0;
function removed(data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type: EventType.DOM_REMOVED, sessionId: 's', data };
}
const dialogRemoved = removed({ role: 'dialog', name: 'Confirm delete', testid: DIALOG_TESTID });

const absentDialog = {
  kind: PredicateKind.ELEMENT,
  query: { testid: DIALOG_TESTID },
  absent: true,
} as const;

function verdictWith(note: string | undefined) {
  return decideVerified({
    pass: true,
    declaredConsequence: true,
    settled: true,
    contradictions: [],
    ...(note === undefined ? {} : { absenceBlindSpot: note }),
    honesty: {
      grade: HonestyGrade.SIGNAL,
      attribution: 'window',
      coverage: { partial: false },
      integrity: { clean: true, issues: [] },
    },
  }).verified;
}

describe('a target the window saw removed', () => {
  it('verifies an absent dialog located by testid', () => {
    const note = absenceBlindSpotNote(absentDialog, spots, [dialogRemoved]);
    expect(note).toBeUndefined();
    expect(verdictWith(note)).toBe(Verified.YES);
  });

  it('verifies the same query written as by/value', () => {
    const byValue = {
      kind: PredicateKind.ELEMENT,
      query: { by: QueryBy.TESTID, value: DIALOG_TESTID },
      absent: true,
    };
    expect(absenceBlindSpotNote(byValue, spots, [dialogRemoved])).toBeUndefined();
  });

  it('verifies the not(element) spelling', () => {
    const negated = {
      kind: PredicateKind.NOT,
      predicate: { kind: PredicateKind.ELEMENT, query: { testid: DIALOG_TESTID } },
    };
    expect(absenceBlindSpotNote(negated, spots, [dialogRemoved])).toBeUndefined();
  });
});

describe('an absence the window did not see leave is still withheld', () => {
  it('withholds yes when the window holds no removal', () => {
    const note = absenceBlindSpotNote(absentDialog, spots, []);
    expect(note).toBeDefined();
    expect(verdictWith(note)).toBe(Verified.UNKNOWN);
  });

  it('withholds yes when a different element was removed', () => {
    const other = removed({ role: 'dialog', name: 'Other', testid: 'other-dialog' });
    expect(absenceBlindSpotNote(absentDialog, spots, [other])).toBeDefined();
  });

  it('withholds yes when the caller passes no window', () => {
    expect(absenceBlindSpotNote(absentDialog, spots)).toBeDefined();
  });

  // A virtualizer unmounts a row when it scrolls out of view. The row's removal says that the row
  // left the DOM, not that the data is gone, so it cannot lift the blind spot.
  it('withholds yes for a row the virtualizer unmounted, also by its testid', () => {
    const rowGone = removed({ role: 'row', name: 'Invoice #42', testid: 'row-42' });
    const absentRow = {
      kind: PredicateKind.ELEMENT,
      query: { testid: 'row-42' },
      absent: true,
    } as const;
    expect(absenceBlindSpotNote(absentRow, spots, [rowGone])).toBeDefined();
  });

  it('withholds yes for absent text of a row inside the virtualized list', () => {
    const rowGone = removed({ role: 'row', name: 'Invoice #42', testid: 'row-42' });
    const absentRow = {
      kind: PredicateKind.ELEMENT,
      query: { text: 'Invoice #42' },
      absent: true,
    } as const;
    const note = absenceBlindSpotNote(absentRow, spots, [rowGone]);
    expect(note).toBeDefined();
    expect(verdictWith(note)).toBe(Verified.UNKNOWN);
  });
});
