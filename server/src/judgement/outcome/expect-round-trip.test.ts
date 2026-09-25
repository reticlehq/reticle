/**
 * A compound assertion survives being saved, whole.
 *
 * This file used to prove the opposite half of the same problem. `Predicate` was a flat struct with
 * one slot per kind, so `allOf[netA, netB]` could not be represented: the converter merged the two
 * arms and the earlier one won, which meant the agent wrote two claims, the file held one, and every
 * later replay reported green for a flow checking less than the person who recorded it believed.
 * The fix then was to REFUSE the conversion — a step lost its expectation and said so, which is bad
 * but honest.
 *
 * There is nothing left to refuse. `FlowStep.expect` is a `Predicate`, so what the agent declared is
 * what the file stores, and this now guards the property that replaces both: the assertion comes
 * back exactly as it went in.
 */
import { describe, expect, it } from 'vitest';
import { FlowFileSchema, PredicateKind, type Predicate } from '@reticlehq/core';

const saved = (assertion: Predicate): Predicate | undefined => {
  const onDisk = JSON.parse(
    JSON.stringify({
      version: 1,
      name: 'checkout',
      createdAt: 1,
      steps: [
        {
          tool: 'reticle_act',
          anchor: { kind: 'testid', value: 'pay' },
          args: {},
          expect: assertion,
        },
      ],
    }),
  ) as unknown;
  const parsed = FlowFileSchema.safeParse(onDisk);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
  return parsed.data.steps[0]?.expect;
};

describe('a saved assertion is the assertion that was made', () => {
  // The exact shape that used to lose an arm.
  it('keeps BOTH arms of a two-request claim', () => {
    const both: Predicate = {
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.NET, urlContains: '/api/charge', status: 200 },
        { kind: PredicateKind.NET, urlContains: '/api/receipt', status: 200 },
      ],
    };
    expect(saved(both)).toEqual(both);
  });

  it('keeps a claim nested two levels down', () => {
    const nested: Predicate = {
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.SETTLED },
        {
          kind: PredicateKind.ANY_OF,
          predicates: [
            { kind: PredicateKind.SIGNAL, name: 'order:placed' },
            { kind: PredicateKind.TEXT, contains: 'Order confirmed' },
          ],
        },
      ],
    };
    expect(saved(nested)).toEqual(nested);
  });

  // `not` had no representation at all in the flat struct, so a negation could never be saved.
  it('keeps a negation, which the old format could not express at all', () => {
    const negated: Predicate = {
      kind: PredicateKind.NOT,
      predicate: { kind: PredicateKind.CONSOLE, level: 'error' },
    };
    expect(saved(negated)).toEqual(negated);
  });

  // A property assertion is what makes a generated value checkable, and the flat struct had no slot
  // for one — so the converter refused the whole step rather than save a weaker claim.
  it('keeps a property assertion on state', () => {
    const generated: Predicate = {
      kind: PredicateKind.STATE,
      path: 'compose.result',
      satisfies: { property: 'nonEmpty' },
    };
    expect(saved(generated)).toEqual(generated);
  });

  it('keeps a relative property, baseline and all', () => {
    const moved: Predicate = {
      kind: PredicateKind.STATE,
      path: 'cart.total',
      satisfies: { property: 'decreased', by: { op: 'equals', value: 12, tolerance: 0.01 } },
    };
    expect(saved(moved)).toEqual(moved);
  });
});
