/**
 * A state negation on one mounted control beside a virtualized list (#2298).
 *
 * One mounted match in another state does not prove that no unmounted row holds a match. A virtual
 * list repeats a control in each row, with the same role, name and testid. The window mounts one
 * row with an unchecked "Notify me", and an unmounted row can hold a checked one.
 *
 * The check is verified only when the page proves that the query cannot match in a virtualized
 * list: the `scope` is a ref to a live region outside each list, and the page answers
 * `outsideVirtualized`. All other queries stay withheld: no scope, no answer from the page, a bare
 * role, multiple mounted matches, a control that is not mounted.
 */
import { describe, expect, it } from 'vitest';
import {
  BlindSpotKind,
  ElementState,
  MatchArg,
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

/** A ref to a settings panel beside the list. The page decides whether it is clear of the list. */
const PANEL = 'e2';

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

/** When the fake page answers `outsideVirtualized: true`. */
const Echo = {
  /** A page older than the argument, or a scope that is not clear of each list. */
  NEVER: 'never',
  /** A current page whose ref scope is clear of each list. */
  WHEN_ASKED: 'when-asked',
  /** A page that sends the field when nobody asked for it. */
  ALWAYS: 'always',
} as const;
type Echo = (typeof Echo)[keyof typeof Echo];

type MatchArgs = Record<string, unknown> & { query: ElementQuery; state?: ElementState };

interface RecordingSession extends PredicateSession {
  /** The arguments of each `match` that carried no state: the read of what is mounted. */
  readonly relaxed: MatchArgs[];
}

function sessionWith(
  match: (query: ElementQuery, state: ElementState | undefined) => ElementDescriptor[],
  echo: Echo = Echo.NEVER,
  countOf: (elements: ElementDescriptor[]) => number = (elements) => elements.length,
): RecordingSession {
  const relaxed: MatchArgs[] = [];
  return {
    relaxed,
    command(_name, args) {
      const payload = args as MatchArgs;
      if (payload.state === undefined) {
        relaxed.push(payload);
      }
      const elements = match(payload.query, payload.state);
      const asked = true === payload[MatchArg.OUTSIDE_VIRTUALIZED];
      const answers = Echo.ALWAYS === echo || (Echo.WHEN_ASKED === echo && asked);
      return Promise.resolve({
        kind: 'command_result',
        ok: true,
        id: 'm1',
        result: {
          matched: elements.length > 0,
          count: countOf(elements),
          elements,
          ...(answers ? { outsideVirtualized: true } : {}),
        },
      });
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
}

/** One "Notify me" box, mounted and unchecked, found by testid or by role and name. */
function mountedCheckbox(echo: Echo = Echo.NEVER): RecordingSession {
  return sessionWith((query, state) => {
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
  }, echo);
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

/** The two spellings of "no element matching `query` is checked". */
function bothSpellings(query: ElementQuery): { spelling: string; predicate: Predicate }[] {
  return [
    {
      spelling: 'not(element)',
      predicate: {
        kind: PredicateKind.NOT,
        predicate: { kind: PredicateKind.ELEMENT, query, state: ElementState.CHECKED },
      },
    },
    {
      spelling: 'absent: true',
      predicate: {
        kind: PredicateKind.ELEMENT,
        query,
        state: ElementState.CHECKED,
        absent: true,
      },
    },
  ];
}

/** The verdict of a passing check on a page that reports 19 unmounted virtual rows. */
async function verdictBesideVirtualRows(
  session: PredicateSession,
  predicate: Predicate,
): Promise<{ note: string | undefined; verified: Verified }> {
  const result = await evaluatePredicate(session, predicate);
  expect(result.pass).toBe(true);
  const note = absenceBlindSpotNote(predicate, VIRTUALIZED, [], result.evidence);
  return { note, verified: verdictWith(note) };
}

const BY_ROLE_AND_NAME: ElementQuery = { role: 'checkbox', name: 'Notify me' };
const BY_TESTID: ElementQuery = { testid: 'x' };
const LOCATORS = [
  { label: 'role and name', query: BY_ROLE_AND_NAME },
  { label: 'testid', query: BY_TESTID },
];

describe('one mounted control in another state is not proof beside a virtualized list (#2298)', () => {
  // The case from the review of #2523. The list repeats "Notify me" in each row. The window mounts
  // one row and its box is unchecked. An unmounted row of the same list can hold a checked one.
  it.each(LOCATORS)(
    'keeps unknown for one mounted unchecked row control by $label when rows are unmounted',
    async ({ query }) => {
      for (const { predicate } of bothSpellings(query)) {
        const { note, verified } = await verdictBesideVirtualRows(mountedCheckbox(), predicate);
        expect(note).toBeDefined();
        expect(verified).toBe(Verified.UNKNOWN);
      }
    },
  );

  it.each(LOCATORS)(
    'keeps unknown by $label when the scope is a ref and the page gives no proof',
    async ({ query }) => {
      // The scope is the mounted row itself, or a region that contains the list. The page then
      // does not answer `outsideVirtualized`, and a scope alone proves nothing.
      for (const { predicate } of bothSpellings({ ...query, scope: PANEL })) {
        const { note, verified } = await verdictBesideVirtualRows(mountedCheckbox(), predicate);
        expect(note).toBeDefined();
        expect(verified).toBe(Verified.UNKNOWN);
      }
    },
  );

  it('keeps unknown for a scoped query on a page too old to give the proof, and asks for it', async () => {
    for (const { predicate } of bothSpellings({ ...BY_ROLE_AND_NAME, scope: PANEL })) {
      const session = mountedCheckbox(Echo.NEVER);
      const { verified } = await verdictBesideVirtualRows(session, predicate);
      expect(verified).toBe(Verified.UNKNOWN);
      expect(session.relaxed).toHaveLength(1);
      expect(session.relaxed[0]?.[MatchArg.OUTSIDE_VIRTUALIZED]).toBe(true);
    }
  });

  it('keeps unknown when the page sends the proof for a query that has no scope', async () => {
    for (const { query } of LOCATORS) {
      for (const { predicate } of bothSpellings(query)) {
        const session = mountedCheckbox(Echo.ALWAYS);
        const { note, verified } = await verdictBesideVirtualRows(session, predicate);
        expect(note).toBeDefined();
        expect(verified).toBe(Verified.UNKNOWN);
        // An unscoped query searches the list too, so this side does not ask for the proof.
        expect(session.relaxed).toHaveLength(1);
        expect(session.relaxed[0]).not.toHaveProperty(MatchArg.OUTSIDE_VIRTUALIZED);
      }
    }
  });
});

describe('a state negation scoped by ref to a region outside each virtualized list (#2298)', () => {
  it.each(LOCATORS)(
    'verifies both spellings by $label when the page proves the scope is clear',
    async ({ query }) => {
      for (const { predicate } of bothSpellings({ ...query, scope: PANEL })) {
        const session = mountedCheckbox(Echo.WHEN_ASKED);
        const { note, verified } = await verdictBesideVirtualRows(session, predicate);
        expect(note).toBeUndefined();
        expect(verified).toBe(Verified.YES);
        expect(session.relaxed[0]?.[MatchArg.OUTSIDE_VIRTUALIZED]).toBe(true);
      }
    },
  );

  it('verifies the by/value testid spelling when the page proves the scope is clear', async () => {
    const query: ElementQuery = { by: QueryBy.TESTID, value: 'x', scope: PANEL };
    for (const { predicate } of bothSpellings(query)) {
      const { note, verified } = await verdictBesideVirtualRows(
        mountedCheckbox(Echo.WHEN_ASKED),
        predicate,
      );
      expect(note).toBeUndefined();
      expect(verified).toBe(Verified.YES);
    }
  });

  it('carries the proof on the evidence of both spellings', async () => {
    const [negated, direct] = bothSpellings({ ...BY_TESTID, scope: PANEL });
    if (negated === undefined || direct === undefined) {
      throw new Error('fixture');
    }
    const session = mountedCheckbox(Echo.WHEN_ASKED);

    const directResult = await evaluatePredicate(session, direct.predicate);
    expect(directResult.evidence).toEqual({
      absent: true,
      nearMiss: [uncheckedBox],
      outsideVirtualized: true,
    });

    const negatedResult = await evaluatePredicate(session, negated.predicate);
    expect(negatedResult.evidence).toMatchObject({
      held: false,
      saw: { evidence: { nearMiss: [uncheckedBox], outsideVirtualized: true } },
    });
  });

  it('still cites a closed shadow root when the page proves the scope is clear', async () => {
    for (const { predicate } of bothSpellings({ ...BY_TESTID, scope: PANEL })) {
      const result = await evaluatePredicate(mountedCheckbox(Echo.WHEN_ASKED), predicate);
      expect(absenceBlindSpotNote(predicate, CLOSED_SHADOW, [], result.evidence)).toContain(
        'cannot prove absence',
      );
    }
  });
});

describe('a scoped state negation that still cannot be proved, with the proof from the page (#2298)', () => {
  it('still withholds yes when the target control is not mounted at all', async () => {
    const emptySession = sessionWith(() => [], Echo.WHEN_ASKED);
    for (const { predicate } of bothSpellings({ ...BY_TESTID, scope: PANEL })) {
      const { note, verified } = await verdictBesideVirtualRows(emptySession, predicate);
      expect(note).toBeDefined();
      expect(verified).toBe(Verified.UNKNOWN);
    }
  });

  it('still withholds yes for a bare role query', async () => {
    const roleSession = sessionWith(
      (_query, state) => (state === ElementState.CHECKED ? [] : [uncheckedBox]),
      Echo.WHEN_ASKED,
    );
    for (const { predicate } of bothSpellings({ role: 'checkbox', scope: PANEL })) {
      const { note, verified } = await verdictBesideVirtualRows(roleSession, predicate);
      expect(note).toBeDefined();
      expect(verified).toBe(Verified.UNKNOWN);
    }
  });

  it('still withholds yes when multiple mounted controls match the locator', async () => {
    const multiSession = sessionWith(
      (_query, state) => (state === ElementState.CHECKED ? [] : [uncheckedBox, secondUncheckedBox]),
      Echo.WHEN_ASKED,
    );
    for (const { predicate } of bothSpellings({ ...BY_ROLE_AND_NAME, scope: PANEL })) {
      const { note, verified } = await verdictBesideVirtualRows(multiSession, predicate);
      expect(note).toBeDefined();
      expect(verified).toBe(Verified.UNKNOWN);
    }
  });

  it('still withholds yes when the mounted match fails a residual check', async () => {
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
    }, Echo.WHEN_ASKED);
    const query: ElementQuery = { testid: 'row-check', name: 'Row 500', scope: PANEL };
    for (const { predicate } of bothSpellings(query)) {
      const { note, verified } = await verdictBesideVirtualRows(row1Session, predicate);
      expect(note).toBeDefined();
      expect(verified).toBe(Verified.UNKNOWN);
    }
  });

  it('still withholds yes when a reply reports a truncated count > 1', async () => {
    const truncatedSession = sessionWith(
      (_query, state) => (state === ElementState.CHECKED ? [] : [uncheckedBox]),
      Echo.WHEN_ASKED,
      (elements) => (0 === elements.length ? 0 : 30),
    );
    const [negated, direct] = bothSpellings({ ...BY_ROLE_AND_NAME, scope: PANEL });
    if (negated === undefined || direct === undefined) {
      throw new Error('fixture');
    }

    const negatedResult = await evaluatePredicate(truncatedSession, negated.predicate);
    expect(
      absenceBlindSpotNote(negated.predicate, VIRTUALIZED, [], negatedResult.evidence),
    ).toBeDefined();

    const directResult = await evaluatePredicate(truncatedSession, direct.predicate);
    expect(directResult.evidence).toEqual({ absent: true });
    expect(
      absenceBlindSpotNote(direct.predicate, VIRTUALIZED, [], directResult.evidence),
    ).toBeDefined();
  });

  it('does not use the proof when a residual check ran on a truncated list', async () => {
    // 30 elements matched and one was described, so `name` was not checked on all of them.
    const truncatedSession = sessionWith(
      (_query, state) => (state === ElementState.CHECKED ? [] : [uncheckedBox]),
      Echo.WHEN_ASKED,
      (elements) => (0 === elements.length ? 0 : 30),
    );
    const query: ElementQuery = { testid: 'x', name: 'Notify me', scope: PANEL };
    for (const { predicate } of bothSpellings(query)) {
      const result = await evaluatePredicate(truncatedSession, predicate);
      expect(JSON.stringify(result.evidence ?? {})).not.toContain(MatchArg.OUTSIDE_VIRTUALIZED);
      expect(absenceBlindSpotNote(predicate, VIRTUALIZED, [], result.evidence)).toBeDefined();
    }
  });

  it('does not attach nearMiss to a passing absent: true check when multiple controls match', async () => {
    const multiSession = sessionWith(
      (_query, state) => (state === ElementState.CHECKED ? [] : [uncheckedBox, secondUncheckedBox]),
      Echo.WHEN_ASKED,
    );
    const direct: Predicate = {
      kind: PredicateKind.ELEMENT,
      query: { role: 'checkbox', scope: PANEL },
      state: ElementState.CHECKED,
      absent: true,
    };
    const result = await evaluatePredicate(multiSession, direct);
    expect(result.pass).toBe(true);
    expect(result.evidence).toEqual({ absent: true });
  });
});
