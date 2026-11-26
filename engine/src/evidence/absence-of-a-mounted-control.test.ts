/**
 * A state negation on one mounted control is verified, also beside a virtualized list (#2298).
 *
 * When a query names one specific control and the near-miss evidence shows that exact element is
 * mounted in another state, an unmounted row in a virtualized list cannot be the target.
 *
 * The other direction stays withheld: when the control is not mounted at all, when the query names
 * only a bare role, or when multiple mounted controls match, unmounted rows could hold a match.
 */
import { describe, expect, it } from 'vitest';
import {
  BlindSpotKind,
  ElementState,
  PredicateKind,
  QueryBy,
  Verified,
  type ElementDescriptor,
  type ElementQuery,
  type Ref,
} from '@reticlehq/core';
import { absenceBlindSpotNote } from './blind-spots.js';
import { decideVerified } from './verified.js';
import { HonestyGrade } from './honesty.js';
import { evaluatePredicate, type Predicate } from '../question/predicate/predicate.js';
import type { PredicateSession } from '../question/predicate/predicate-session.js';

const VIRTUALIZED = [{ kind: BlindSpotKind.VIRTUALIZED_UNMOUNTED, count: 19 }];
const CLOSED_SHADOW = [{ kind: BlindSpotKind.CLOSED_SHADOW_ROOT, count: 1 }];

const uncheckedBox: ElementDescriptor = {
  ref: 'e4' as Ref,
  role: 'checkbox',
  name: 'Notify me',
  states: [ElementState.VISIBLE, ElementState.ENABLED],
  visible: true,
};

const secondUncheckedBox: ElementDescriptor = {
  ref: 'e5' as Ref,
  role: 'checkbox',
  name: 'Notify me',
  states: [ElementState.VISIBLE, ElementState.ENABLED],
  visible: true,
};

function sessionWith(
  match: (query: ElementQuery, state: ElementState | undefined) => ElementDescriptor[],
): PredicateSession {
  return {
    command(_name, args) {
      const payload = args as { query: ElementQuery; state?: ElementState };
      const elements = match(payload.query, payload.state);
      return Promise.resolve({
        kind: 'command_result',
        ok: true,
        id: 'm1',
        result: {
          matched: elements.length > 0,
          count: elements.length,
          elements,
        },
      });
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

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
      coverage: { partial: true },
      integrity: { clean: true, issues: [] },
    },
  }).verified;
}

describe('a state negation on one mounted control beside a virtualized list (#2298)', () => {
  const mountedCheckboxSession = sessionWith((query, state) => {
    if (state === ElementState.CHECKED) {
      return [];
    }
    if (
      'x' === query.testid ||
      (QueryBy.TESTID === query.by && 'x' === query.value) ||
      ('checkbox' === query.role && 'Notify me' === query.name)
    ) {
      return [uncheckedBox];
    }
    return [];
  });

  it('verifies not(element { testid, state: checked }) when the box is mounted and unchecked', async () => {
    const predicate: Predicate = {
      kind: PredicateKind.NOT,
      predicate: {
        kind: PredicateKind.ELEMENT,
        query: { testid: 'x' },
        state: ElementState.CHECKED,
      },
    };
    const result = await evaluatePredicate(mountedCheckboxSession, predicate);
    expect(result.pass).toBe(true);

    const note = absenceBlindSpotNote(predicate, VIRTUALIZED, [], result.evidence);
    expect(note).toBeUndefined();
    expect(verdictWith(note)).toBe(Verified.YES);
  });

  it('verifies the direct absent: true spelling when the box is mounted and unchecked', async () => {
    const predicate: Predicate = {
      kind: PredicateKind.ELEMENT,
      query: { testid: 'x' },
      state: ElementState.CHECKED,
      absent: true,
    };
    const result = await evaluatePredicate(mountedCheckboxSession, predicate);
    expect(result.pass).toBe(true);

    const note = absenceBlindSpotNote(predicate, VIRTUALIZED, [], result.evidence);
    expect(note).toBeUndefined();
    expect(verdictWith(note)).toBe(Verified.YES);
  });

  it('verifies by/value testid and role+name queries for one mounted control', async () => {
    const byValue: Predicate = {
      kind: PredicateKind.NOT,
      predicate: {
        kind: PredicateKind.ELEMENT,
        query: { by: QueryBy.TESTID, value: 'x' },
        state: ElementState.CHECKED,
      },
    };
    const byValueResult = await evaluatePredicate(mountedCheckboxSession, byValue);
    expect(absenceBlindSpotNote(byValue, VIRTUALIZED, [], byValueResult.evidence)).toBeUndefined();

    const byRoleName: Predicate = {
      kind: PredicateKind.NOT,
      predicate: {
        kind: PredicateKind.ELEMENT,
        query: { role: 'checkbox', name: 'Notify me' },
        state: ElementState.CHECKED,
      },
    };
    const byRoleNameResult = await evaluatePredicate(mountedCheckboxSession, byRoleName);
    expect(
      absenceBlindSpotNote(byRoleName, VIRTUALIZED, [], byRoleNameResult.evidence),
    ).toBeUndefined();
  });

  it('still withholds yes when the target control is not mounted at all', async () => {
    const emptySession = sessionWith(() => []);
    const predicate: Predicate = {
      kind: PredicateKind.NOT,
      predicate: {
        kind: PredicateKind.ELEMENT,
        query: { testid: 'x' },
        state: ElementState.CHECKED,
      },
    };
    const result = await evaluatePredicate(emptySession, predicate);
    expect(result.pass).toBe(true);

    const note = absenceBlindSpotNote(predicate, VIRTUALIZED, [], result.evidence);
    expect(note).toBeDefined();
    expect(verdictWith(note)).toBe(Verified.UNKNOWN);
  });

  it('still withholds yes for a bare role query that could match unmounted rows', async () => {
    const roleSession = sessionWith((_query, state) =>
      state === ElementState.CHECKED ? [] : [uncheckedBox],
    );
    const predicate: Predicate = {
      kind: PredicateKind.NOT,
      predicate: {
        kind: PredicateKind.ELEMENT,
        query: { role: 'checkbox' },
        state: ElementState.CHECKED,
      },
    };
    const result = await evaluatePredicate(roleSession, predicate);
    expect(result.pass).toBe(true);

    const note = absenceBlindSpotNote(predicate, VIRTUALIZED, [], result.evidence);
    expect(note).toBeDefined();
    expect(verdictWith(note)).toBe(Verified.UNKNOWN);
  });

  it('still withholds yes when multiple mounted controls match the locator', async () => {
    const multiSession = sessionWith((_query, state) =>
      state === ElementState.CHECKED ? [] : [uncheckedBox, secondUncheckedBox],
    );
    const predicate: Predicate = {
      kind: PredicateKind.NOT,
      predicate: {
        kind: PredicateKind.ELEMENT,
        query: { role: 'checkbox', name: 'Notify me' },
        state: ElementState.CHECKED,
      },
    };
    const result = await evaluatePredicate(multiSession, predicate);
    expect(result.pass).toBe(true);

    const note = absenceBlindSpotNote(predicate, VIRTUALIZED, [], result.evidence);
    expect(note).toBeDefined();
    expect(verdictWith(note)).toBe(Verified.UNKNOWN);
  });

  it('still cites a closed shadow root even when one control is mounted', async () => {
    const predicate: Predicate = {
      kind: PredicateKind.NOT,
      predicate: {
        kind: PredicateKind.ELEMENT,
        query: { testid: 'x' },
        state: ElementState.CHECKED,
      },
    };
    const result = await evaluatePredicate(mountedCheckboxSession, predicate);
    expect(absenceBlindSpotNote(predicate, CLOSED_SHADOW, [], result.evidence)).toContain(
      'cannot prove absence',
    );
  });

  it('still withholds yes in both spellings when the mounted match fails a residual check', async () => {
    const row1: ElementDescriptor = {
      ref: 'e6' as Ref,
      role: 'checkbox',
      name: 'Row 1',
      states: [ElementState.VISIBLE, ElementState.ENABLED],
      visible: true,
    };
    const row1Session = sessionWith((query, state) => {
      if (state === ElementState.CHECKED) {
        return [];
      }
      return 'row-check' === query.testid ? [row1] : [];
    });
    const query: ElementQuery = { testid: 'row-check', name: 'Row 500' };
    const negated: Predicate = {
      kind: PredicateKind.NOT,
      predicate: { kind: PredicateKind.ELEMENT, query, state: ElementState.CHECKED },
    };
    const direct: Predicate = {
      kind: PredicateKind.ELEMENT,
      query,
      state: ElementState.CHECKED,
      absent: true,
    };

    const negatedResult = await evaluatePredicate(row1Session, negated);
    expect(negatedResult.pass).toBe(true);
    expect(absenceBlindSpotNote(negated, VIRTUALIZED, [], negatedResult.evidence)).toBeDefined();
    expect(
      verdictWith(absenceBlindSpotNote(negated, VIRTUALIZED, [], negatedResult.evidence)),
    ).toBe(Verified.UNKNOWN);

    const directResult = await evaluatePredicate(row1Session, direct);
    expect(directResult.pass).toBe(true);
    expect(absenceBlindSpotNote(direct, VIRTUALIZED, [], directResult.evidence)).toBeDefined();
    expect(verdictWith(absenceBlindSpotNote(direct, VIRTUALIZED, [], directResult.evidence))).toBe(
      Verified.UNKNOWN,
    );
  });

  it('still withholds yes in both spellings when a reply reports a truncated count > 1', async () => {
    const truncatedSession: PredicateSession = {
      command(_name, args) {
        const payload = args as { state?: ElementState };
        if (payload.state === ElementState.CHECKED) {
          return Promise.resolve({
            kind: 'command_result',
            ok: true,
            id: 'm1',
            result: { matched: false, count: 0, elements: [] },
          });
        }
        return Promise.resolve({
          kind: 'command_result',
          ok: true,
          id: 'm1',
          result: { matched: true, count: 30, elements: [uncheckedBox] },
        });
      },
      eventsSince: () => [],
      onEvent: () => () => undefined,
      elapsed: () => 0,
    };
    const query: ElementQuery = { role: 'checkbox', name: 'Notify me' };
    const negated: Predicate = {
      kind: PredicateKind.NOT,
      predicate: { kind: PredicateKind.ELEMENT, query, state: ElementState.CHECKED },
    };
    const direct: Predicate = {
      kind: PredicateKind.ELEMENT,
      query,
      state: ElementState.CHECKED,
      absent: true,
    };

    const negatedResult = await evaluatePredicate(truncatedSession, negated);
    expect(absenceBlindSpotNote(negated, VIRTUALIZED, [], negatedResult.evidence)).toBeDefined();

    const directResult = await evaluatePredicate(truncatedSession, direct);
    expect(directResult.evidence).toEqual({ absent: true });
    expect(absenceBlindSpotNote(direct, VIRTUALIZED, [], directResult.evidence)).toBeDefined();
  });

  it('does not attach nearMiss to a passing absent: true check when multiple controls match', async () => {
    const multiSession = sessionWith((_query, state) =>
      state === ElementState.CHECKED ? [] : [uncheckedBox, secondUncheckedBox],
    );
    const direct: Predicate = {
      kind: PredicateKind.ELEMENT,
      query: { role: 'checkbox' },
      state: ElementState.CHECKED,
      absent: true,
    };
    const result = await evaluatePredicate(multiSession, direct);
    expect(result.pass).toBe(true);
    expect(result.evidence).toEqual({ absent: true });
  });
});
