import { describe, it, expect } from 'vitest';
import {
  isPresenceOnlyAssertion,
  assertsDerivedIpcStatus,
  gradeOfPredicate,
} from './assert-grade.js';
import { HonestyGrade } from '@reticlehq/engine/evidence/honesty.js';
import type { Predicate } from '@reticlehq/engine/question/predicate/predicate.js';

describe('isPresenceOnlyAssertion', () => {
  it('flags a bare element predicate', () => {
    expect(isPresenceOnlyAssertion({ kind: 'element', query: { role: 'button' } })).toBe(true);
  });

  it('flags a bare text predicate', () => {
    expect(isPresenceOnlyAssertion({ kind: 'text', contains: 'Saved' })).toBe(true);
  });

  /**
   * The nudge's whole claim is that "a locator healed to the wrong element, or a stale render, can
   * satisfy this while the feature is broken". That is true of a bare locator and false once the
   * predicate asserts the element's content: a wrong element now has to carry the same value.
   *
   * It matters because the advice argues for REPLACING the assertion. Telling an agent that a value
   * check proves nothing is how a sound assertion gets swapped for a different one, or dropped.
   */
  it('does NOT flag an element predicate that checks the value', () => {
    expect(
      isPresenceOnlyAssertion({
        kind: 'element',
        query: { role: 'textbox', name: 'GST amount', value: '274.58' },
      }),
    ).toBe(false);
  });

  it('does NOT flag an element predicate that checks the text', () => {
    expect(
      isPresenceOnlyAssertion({ kind: 'element', query: { role: 'status', text: 'Saved' } }),
    ).toBe(false);
  });

  it('still flags a NEGATED content check, because absence is satisfied by a wrong locator', () => {
    // The mirror of the two cases above. Asserting a value makes a positive claim harder to fake and
    // a negative one no harder at all: "no element reads 274.58" is trivially true of a selector
    // that matches nothing, which is the oldest false green there is.
    expect(
      isPresenceOnlyAssertion({
        kind: 'not',
        predicate: { kind: 'element', query: { role: 'textbox', value: '274.58' } },
      }),
    ).toBe(true);
  });

  it('still flags a locator that merely names the element', () => {
    // `name` is part of the locator, not a claim about content: finding an element called "Save"
    // says nothing about what it did.
    expect(
      isPresenceOnlyAssertion({ kind: 'element', query: { role: 'button', name: 'Save' } }),
    ).toBe(true);
  });

  it('does NOT flag a signal consequence', () => {
    expect(isPresenceOnlyAssertion({ kind: 'signal', name: 'order:placed' })).toBe(false);
  });

  it('does NOT flag a net consequence', () => {
    expect(isPresenceOnlyAssertion({ kind: 'net', urlContains: '/api/order', status: 200 })).toBe(
      false,
    );
  });

  it('does NOT flag presence when a consequence is allOf-ed in', () => {
    const p: Predicate = {
      kind: 'allOf',
      predicates: [
        { kind: 'element', query: { text: 'Done' } },
        { kind: 'signal', name: 'order:placed' },
      ],
    };
    expect(isPresenceOnlyAssertion(p)).toBe(false);
  });

  it('flags an allOf of only presence checks', () => {
    const p: Predicate = {
      kind: 'allOf',
      predicates: [
        { kind: 'element', query: { role: 'dialog' } },
        { kind: 'text', contains: 'Welcome' },
      ],
    };
    expect(isPresenceOnlyAssertion(p)).toBe(true);
  });

  it('does NOT flag non-presence predicates (route / settled / console)', () => {
    expect(isPresenceOnlyAssertion({ kind: 'route', pathname: '/success' })).toBe(false);
    expect(isPresenceOnlyAssertion({ kind: 'settled' })).toBe(false);
    expect(isPresenceOnlyAssertion({ kind: 'console', level: 'error', absent: true })).toBe(false);
  });

  it('flags a negated presence check (still presence-shaped)', () => {
    expect(
      isPresenceOnlyAssertion({
        kind: 'not',
        predicate: { kind: 'element', query: { text: 'x' } },
      }),
    ).toBe(true);
  });
});

describe('derived-status advice — steering off a number Reticle invented', () => {
  /**
   * IPC has no status code. Reticle derives 200/500 so the existing filters keep working, but an
   * agent that asserts `status: 500` is asserting on Reticle's own encoding rather than on what the
   * app did — and if that derivation ever changes, the assertion silently stops meaning what it
   * meant. `ok` is the field that describes the app. Nudge, do not break: the assertion still passes.
   */
  it('advises `ok` when a net assertion pins a status on an IPC call', () => {
    expect(assertsDerivedIpcStatus({ kind: 'net', urlContains: 'ipc://save', status: 500 })).toBe(
      true,
    );
  });

  it('says nothing when the assertion already uses ok', () => {
    expect(assertsDerivedIpcStatus({ kind: 'net', urlContains: 'ipc://save', ok: false })).toBe(
      false,
    );
  });

  it('says nothing about a real HTTP status, which the server genuinely sent', () => {
    expect(assertsDerivedIpcStatus({ kind: 'net', urlContains: '/api/save', status: 500 })).toBe(
      false,
    );
  });

  it('reaches into allOf/anyOf, where a weak clause is easiest to miss', () => {
    expect(
      assertsDerivedIpcStatus({
        kind: 'allOf',
        predicates: [
          { kind: 'console', level: 'error', absent: true },
          { kind: 'net', urlContains: 'ipc://save', status: 500 },
        ],
      }),
    ).toBe(true);
  });
});

/**
 * The grade has to look INSIDE a combinator.
 *
 * `gradeOfPredicate` switched on the top-level kind, so every `allOf`/`anyOf` fell to `default` and
 * was graded `presence` — the weakest rung — however strong its children were. Measured against a
 * running app: the same state predicate reported "assertion held at state grade" bare and
 * "assertion held at presence grade" wrapped in a single-child `allOf`.
 *
 * It is not cosmetic. `docs/predicates.mdx` calls `allOf` "the workhorse", and `meetsHonestyBar`
 * is a published engine API whose `minGrade` bar would reject a genuine `allOf[signal, net]`
 * verdict. The recursive `walk` this file already uses for `isPresenceOnlyAssertion` proves the
 * descent was always intended.
 */
describe('gradeOfPredicate descends into combinators', () => {
  const signal: Predicate = { kind: 'signal', name: 'order:placed' };
  const net: Predicate = { kind: 'net', method: 'POST', urlContains: '/api/order' };
  const state: Predicate = { kind: 'state', path: 'cart.total' };
  const element: Predicate = { kind: 'element', query: { role: 'button' } };

  it('grades a leaf by its own kind, as it always did', () => {
    expect(gradeOfPredicate(signal)).toBe(HonestyGrade.SIGNAL);
    expect(gradeOfPredicate(net)).toBe(HonestyGrade.NET);
    expect(gradeOfPredicate(state)).toBe(HonestyGrade.STATE);
    expect(gradeOfPredicate(element)).toBe(HonestyGrade.PRESENCE);
  });

  // Wrapping a predicate in allOf changes nothing about what it proves.
  it('does not weaken a predicate by wrapping it in allOf', () => {
    expect(gradeOfPredicate({ kind: 'allOf', predicates: [state] })).toBe(HonestyGrade.STATE);
    expect(gradeOfPredicate({ kind: 'allOf', predicates: [signal] })).toBe(HonestyGrade.SIGNAL);
  });

  // allOf greens only when EVERY branch held, so the strongest branch is honestly claimable.
  it('takes the strongest branch of an allOf, because all of them held', () => {
    expect(gradeOfPredicate({ kind: 'allOf', predicates: [element, net, signal] })).toBe(
      HonestyGrade.SIGNAL,
    );
    expect(gradeOfPredicate({ kind: 'allOf', predicates: [element, state] })).toBe(
      HonestyGrade.STATE,
    );
  });

  /*
   * anyOf greens on ONE branch, and nothing in the predicate says which.
   *
   * Claiming the strongest branch would let a verdict that only proved presence report `signal`,
   * and a `minGrade: net` gate would then trust it. That is the exact false green the grade exists
   * to prevent, so an OR is graded by its WEAKEST branch.
   */
  it('takes the weakest branch of an anyOf, because only one of them held', () => {
    expect(gradeOfPredicate({ kind: 'anyOf', predicates: [signal, element] })).toBe(
      HonestyGrade.PRESENCE,
    );
    expect(gradeOfPredicate({ kind: 'anyOf', predicates: [signal, net] })).toBe(HonestyGrade.NET);
  });

  it('descends through nesting rather than stopping at the first level', () => {
    expect(
      gradeOfPredicate({
        kind: 'allOf',
        predicates: [element, { kind: 'allOf', predicates: [state, signal] }],
      }),
    ).toBe(HonestyGrade.SIGNAL);
  });

  // An absence claim stays at presence: "the error is gone" is satisfied trivially by a locator
  // that never matched anything, which is the same argument `walk` already makes about negation.
  it('keeps a negation at presence', () => {
    expect(gradeOfPredicate({ kind: 'not', predicate: signal })).toBe(HonestyGrade.PRESENCE);
  });

  /**
   * This asserted `PRESENCE` and was pinning the defect, not the design.
   *
   * Its real concern is in its own title — "rather than crashing" — and `NONE` does not crash
   * either. `PRESENCE` was the incidental value the code happened to return, and it is one rung
   * above the floor `combine()`'s doc comment always claimed. That rung is what let an empty
   * combinator past `VACUOUS_GRADE` and into a `verified: "yes"`.
   *
   * The schema refuses an empty combinator now, so reaching this needs a constructed predicate
   * rather than a parsed one — which is exactly why the floor is still worth asserting.
   */
  it('grades a combinator with no branches at the floor rather than crashing', () => {
    expect(gradeOfPredicate({ kind: 'allOf', predicates: [] })).toBe(HonestyGrade.NONE);
    expect(gradeOfPredicate({ kind: 'anyOf', predicates: [] })).toBe(HonestyGrade.NONE);
  });
});
