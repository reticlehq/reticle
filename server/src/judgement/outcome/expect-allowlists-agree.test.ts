import { describe, expect, it } from 'vitest';
import { PredicateKind } from '@reticlehq/core';
import { predicateToExpect, enforcedOnReplay } from './predicate-to-expect.js';
import { successToPredicate } from '@/language/flows/flow-success.js';
import type { Predicate } from '@reticlehq/engine/question/predicate/predicate.js';

/**
 * THREE allowlists, ONE question — and they have drifted apart twice.
 *
 * An assertion an agent makes with `act_and_wait { until }` reaches a saved flow through three
 * separate gates, each with its own list of kinds:
 *
 *   1. `predicateToExpect`  — can this be EXPRESSED as a FlowExpect?
 *   2. `enforcedOnReplay`   — will replay actually CHECK it? (only survivors reach disk)
 *   3. `successToPredicate` — can it be COMPILED BACK for the replay to evaluate?
 *
 * All three must agree. When they do not, the failure is silent and always in the same direction: a
 * verdict that was proved live is recorded as a flow that cannot go red — a regression test that
 * passes whatever the app does, which is the exact false green this product exists to remove.
 *
 * It has happened twice, documented in `predicate-to-expect.ts` both times. Once when replay learned
 * to evaluate every kind and the filter was not updated — "the condition was met and the filter was
 * not updated, so the two drifted", costing every `net` assertion an agent ever made. Then again
 * the day `route` was added: the field landed in core, the mapping landed, and a route assertion
 * still reached disk as NOTHING because list 2 had not heard of it. Every unit test was green both
 * times; both were found by driving a real app.
 *
 * A comment cannot hold three lists in step. This can.
 */

/** One representative predicate per kind — the shape an agent would actually write. */
const SAMPLES: Record<string, Predicate> = {
  [PredicateKind.ELEMENT]: { kind: PredicateKind.ELEMENT, query: { testid: 'submit' } },
  [PredicateKind.TEXT]: { kind: PredicateKind.TEXT, contains: 'Saved' },
  [PredicateKind.SIGNAL]: { kind: PredicateKind.SIGNAL, name: 'order:placed' },
  [PredicateKind.NET]: { kind: PredicateKind.NET, urlContains: '/api/orders' },
  [PredicateKind.STATE]: { kind: PredicateKind.STATE, path: 'cart.total' },
  [PredicateKind.ROUTE]: { kind: PredicateKind.ROUTE, contains: 'checkout' },
  [PredicateKind.CONSOLE]: { kind: PredicateKind.CONSOLE, absent: true },
  [PredicateKind.ANIMATION]: { kind: PredicateKind.ANIMATION, name: 'fade' },
  [PredicateKind.SETTLED]: { kind: PredicateKind.SETTLED },
  [PredicateKind.ALL_OF]: {
    kind: PredicateKind.ALL_OF,
    predicates: [{ kind: PredicateKind.SIGNAL, name: 'a' }],
  },
  [PredicateKind.ANY_OF]: {
    kind: PredicateKind.ANY_OF,
    predicates: [{ kind: PredicateKind.SIGNAL, name: 'a' }],
  },
  [PredicateKind.NOT]: {
    kind: PredicateKind.NOT,
    predicate: { kind: PredicateKind.SIGNAL, name: 'a' },
  },
};

describe('the three gates an assertion passes through', () => {
  it('has a sample for every kind, so a pass cannot be a pass over nothing', () => {
    for (const kind of Object.values(PredicateKind)) {
      expect(SAMPLES[kind], `no sample predicate for "${kind}"`).toBeDefined();
    }
  });

  it('never records an expectation that replay will silently drop', () => {
    // The drift that has actually happened, twice. Expressing a kind and then filtering it out
    // means the agent's assertion is discarded between the drive and the file, and nothing says so.
    const dropped = Object.values(PredicateKind).filter((kind) => {
      const sample = SAMPLES[kind];
      if (sample === undefined) return false;
      const expressed = predicateToExpect(sample);
      return expressed !== undefined && enforcedOnReplay(expressed) === undefined;
    });
    expect(
      dropped,
      'predicateToExpect can express these and enforcedOnReplay throws them away, so an assertion ' +
        'the agent MADE never reaches the file — and the saved flow cannot go red. Add them to the ' +
        'filter, or stop expressing them.',
    ).toEqual([]);
  });

  it('never keeps an expectation replay cannot compile back', () => {
    // The mirror. Keeping something `successToPredicate` cannot read grades the flow "asserted"
    // while nothing evaluates it — a false green inside the feature built to prevent them.
    const uncompilable = Object.values(PredicateKind).filter((kind) => {
      const sample = SAMPLES[kind];
      if (sample === undefined) return false;
      const kept = enforcedOnReplay(predicateToExpect(sample));
      return kept !== undefined && successToPredicate(kept, new Set()) === undefined;
    });
    expect(
      uncompilable,
      'these survive to the file and successToPredicate cannot turn them back into something ' +
        'replay evaluates, so the flow reads as asserted while nothing checks it.',
    ).toEqual([]);
  });

  it('round-trips the kind itself, so an assertion does not quietly become a different one', () => {
    /*
     * "Still present", not "still the top-level node" — and the difference is a real design, not a
     * loophole. `console.absent` compiles to `allOf [settled, console]` ON PURPOSE: a wait-until-true
     * waiter reads the console at its first poll, sees no error yet and passes BEFORE the action's
     * error fires, so the check is gated on settle. The first version of this test asserted the top
     * level and flagged that as drift. The code was right and the assertion was too strict.
     *
     * `allOf` itself is exempt: it legitimately narrows to its one expressible part.
     */
    const mentions = (predicate: Predicate, kind: string): boolean =>
      predicate.kind === kind ||
      (predicate.kind === PredicateKind.ALL_OF &&
        (predicate.predicates ?? []).some((part) => mentions(part, kind)));

    const changed: string[] = [];
    for (const kind of Object.values(PredicateKind)) {
      if (kind === PredicateKind.ALL_OF) continue;
      const sample = SAMPLES[kind];
      if (sample === undefined) continue;
      const kept = enforcedOnReplay(predicateToExpect(sample));
      if (kept === undefined) continue;
      const back = successToPredicate(kept, new Set());
      if (back !== undefined && !mentions(back, kind)) changed.push(`${kind} -> ${back.kind}`);
    }
    expect(
      changed,
      'an assertion of one kind came back as another and is no longer anywhere in the compiled ' +
        'predicate, so replay is checking something the agent did not ask for.',
    ).toEqual([]);
  });

  it('round-trips the POLARITY, so a proven absence never comes back as a presence check', () => {
    /*
     * The same three gates, read for direction rather than for kind — and the direction is where
     * the third drift landed (#988). `element` had no `absent` on the FlowExpect side, so the field
     * was dropped at gate 1 and the surviving locator compiled back at gate 3 as something to FIND.
     * The kind round-tripped perfectly; the claim came back inverted.
     *
     * That failure is invisible to every assertion above, and it is the worse one: a lost assertion
     * leaves a flow that cannot go red, while a reversed one is red on a working app and green on
     * the regression it was recorded to catch.
     */
    const negatives: Predicate[] = [
      { kind: PredicateKind.ELEMENT, query: { testid: 'error-banner' }, absent: true },
      {
        kind: PredicateKind.ELEMENT,
        query: { role: 'alert', name: 'Upload failed' },
        absent: true,
      },
      { kind: PredicateKind.CONSOLE, absent: true },
      { kind: PredicateKind.TEXT, contains: 'Saving…', absent: true },
    ];

    const stillAbsent = (predicate: Predicate): boolean =>
      ('absent' in predicate && true === predicate.absent) ||
      (predicate.kind === PredicateKind.ALL_OF &&
        predicate.predicates.some((part) => stillAbsent(part)));

    const flipped: string[] = [];
    for (const negative of negatives) {
      const kept = enforcedOnReplay(predicateToExpect(negative));
      // Refusing to record it is honest — the flow is then assertion-free, which is graded and
      // warned about. Recording it and losing the `absent` is not.
      if (kept === undefined) continue;
      const back = successToPredicate(kept, new Set());
      if (back === undefined || !stillAbsent(back)) flipped.push(JSON.stringify(negative));
    }
    expect(
      flipped,
      'these were recorded as assertions and came back POSITIVE, so the replayed flow asserts the ' +
        'opposite of what the agent proved — green exactly when the feature is broken.',
    ).toEqual([]);
  });
});
