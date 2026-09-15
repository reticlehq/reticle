import { describe, it, expect } from 'vitest';
import { typecheckComposite, TypeErrorKind } from './typecheck.js';

/**
 * The stitch check: does what one document GUARANTEES satisfy what the next one NEEDS?
 *
 * This is the rule composition exists for. A sub-flow that assumes it starts signed-in passes alone
 * and fails inside a composite for a reason neither document mentions — and the report blames the
 * payment form, which is working correctly.
 *
 * The protocol asks; it does not judge. Only the REALM knows what its own state values mean, so the
 * comparison arrives as a callback and `undefined` is a real answer: "I cannot tell." A realm that
 * cannot tell must not be read as agreement — that would be a check which can only ever pass, which
 * is the shape of a guard that gets deleted later for never having been able to fire.
 */

const doc = (
  name: string,
  o: { invokes?: string[]; requires?: unknown; ensures?: unknown } = {},
) => ({
  name,
  requires: o.requires,
  ensures: o.ensures,
  steps: (o.invokes ?? []).map((invoke, i) => ({ id: `s${String(i)}`, invoke, at: i })),
});

// A realm that understands flat boolean state: every key the requirement names must already match.
const satisfies = (ensures: unknown, requires: unknown): boolean | undefined => {
  if (requires === undefined) return true;
  if (typeof requires !== 'object' || requires === null) return undefined;
  const have = (typeof ensures === 'object' && ensures !== null ? ensures : {}) as Record<
    string,
    unknown
  >;
  return Object.entries(requires as Record<string, unknown>).every(([k, v]) => have[k] === v);
};

describe('stitching one document to the next', () => {
  it('accepts a composite whose parts line up', () => {
    const errors = typecheckComposite(
      [
        doc('full', { invokes: ['signup', 'pay'], requires: { signedIn: false } }),
        doc('signup', { requires: { signedIn: false }, ensures: { signedIn: true } }),
        doc('pay', { requires: { signedIn: true }, ensures: { hasPlan: true } }),
      ],
      'full',
      satisfies,
    );
    expect(errors).toEqual([]);
  });

  it('refuses the same parts in the wrong order, naming what is missing', () => {
    // pay-then-signup: nothing has established signedIn when `pay` starts. Without this check the
    // composite runs and dies inside a payment form that is working perfectly.
    const errors = typecheckComposite(
      [
        doc('full', { invokes: ['pay', 'signup'], requires: { signedIn: false } }),
        doc('signup', { requires: { signedIn: false }, ensures: { signedIn: true } }),
        doc('pay', { requires: { signedIn: true }, ensures: { hasPlan: true } }),
      ],
      'full',
      satisfies,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe(TypeErrorKind.UNSATISFIED_REQUIREMENT);
    expect(errors[0]?.detail).toContain('pay');
    expect(errors[0]?.step).toBe(0);
  });

  it('says so when the realm CANNOT judge, rather than passing', () => {
    // The important one. "I cannot tell" is not "yes" — a check that treats it as agreement can
    // only ever pass, and a guard that cannot fail is worse than no guard because it reads as one.
    const errors = typecheckComposite(
      [doc('full', { invokes: ['pay'] }), doc('pay', { requires: 'signed-in-somehow' })],
      'full',
      () => undefined,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe(TypeErrorKind.UNJUDGED_REQUIREMENT);
  });

  it('checks nothing when no comparison is supplied — composition without contracts still works', () => {
    const errors = typecheckComposite(
      [doc('full', { invokes: ['pay'] }), doc('pay', { requires: { signedIn: true } })],
      'full',
    );
    expect(errors).toEqual([]);
  });

  it('lets a document that requires nothing follow anything', () => {
    const errors = typecheckComposite(
      [doc('full', { invokes: ['a', 'b'] }), doc('a', { ensures: { x: 1 } }), doc('b')],
      'full',
      satisfies,
    );
    expect(errors).toEqual([]);
  });
});
