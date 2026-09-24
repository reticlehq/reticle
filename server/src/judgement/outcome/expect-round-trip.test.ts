/**
 * Saving a compound assertion must not quietly save a smaller one (0.1).
 *
 * `FlowExpect` is a flat struct with one slot per kind, and `merge` is `{ ...from, ...into }` — a
 * shallow spread where the EARLIER arm wins a key collision. So `allOf[netA, netB]` saves as `netA`,
 * and `netB` is gone with nothing said.
 *
 * That is a false green with a long fuse. The agent wrote two claims, the file holds one, and every
 * later replay reports green for a flow that checks less than the person who recorded it believed.
 * Nothing in the verdict can see the difference, because by then the second claim does not exist.
 *
 * The rule this file already states in its own header is the one being broken: "never write an
 * assertion into a flow file that nothing evaluates". Its twin is the half that was missing — never
 * write a SMALLER assertion than the one you were handed. Refusing costs a step its expectation and
 * says so; merging costs the flow its meaning and does not.
 */
import { describe, expect, it } from 'vitest';
import { PredicateKind } from '@reticlehq/core';
// `Predicate` still lives in engine — core owns the KINDS and engine owns the shape. Finishing that
// split is task 3.2, which is priced in the plan and not done.
import type { Predicate } from '@reticlehq/engine/question/predicate/predicate-schema.js';
import { predicateToExpect } from './predicate-to-expect.js';

const net = (urlContains: string): Predicate => ({ kind: PredicateKind.NET, urlContains });
const signal = (name: string): Predicate => ({ kind: PredicateKind.SIGNAL, name });
const allOf = (...predicates: Predicate[]): Predicate => ({
  kind: PredicateKind.ALL_OF,
  predicates,
});

describe('what a compound predicate saves as', () => {
  it('keeps a compound of DIFFERENT kinds, which the flat struct can hold', () => {
    const out = predicateToExpect(allOf(net('/api/pay'), signal('paid')));
    expect(out?.signal, 'different slots, nothing collides, nothing is lost').toBe('paid');
    expect(out?.net).toBeDefined();
  });

  /* The reported shape: two arms of one kind, one slot. */
  it('refuses rather than silently dropping the second of two nets', () => {
    const out = predicateToExpect(allOf(net('/api/pay'), net('/api/receipt')));
    expect(
      out,
      'saved as the first arm alone — the flow now checks half of what was written, and replays green',
    ).toBeUndefined();
  });

  it('refuses two signals for the same reason', () => {
    expect(predicateToExpect(allOf(signal('paid'), signal('emailed')))).toBeUndefined();
  });

  /* One arm is not a collision, and must still save — refusing everything would be its own defect. */
  it('still saves a single-armed compound', () => {
    expect(predicateToExpect(allOf(signal('paid')))?.signal).toBe('paid');
  });
});
