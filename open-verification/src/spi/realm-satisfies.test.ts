import { describe, expect, it } from 'vitest';
import { typecheckComposite, TypeErrorKind } from '../language/typecheck.js';
import { Realm } from './realm.js';

/**
 * The state-contract comparison belongs to the REALM, and a realm that has none says so.
 *
 * `Realm.satisfies` defaults to `undefined` rather than to `true` or `false`, and that is the whole
 * point. A realm which has never seen a state contract has no honest answer; making it invent one
 * would be worse than letting it decline. `undefined` is reported as `unjudged-requirement`, never
 * as agreement — a check that reads "cannot tell" as "yes" can only ever pass, and a check that
 * cannot fail reads as a guard while being none.
 *
 * This is exercised through `typecheckComposite` rather than by calling the method, because the
 * behaviour that matters is what the DEFAULT does to a composite, not what the method returns.
 */

const doc = (name: string, o: { invokes?: string[]; requires?: unknown } = {}) => ({
  name,
  requires: o.requires,
  steps: (o.invokes ?? []).map((invoke, i) => ({ id: `s${String(i)}`, invoke, at: i })),
});

describe('a realm with no state-contract vocabulary', () => {
  const docs = [doc('full', { invokes: ['pay'] }), doc('pay', { requires: { signedIn: true } })];

  it('leaves the requirement UNJUDGED rather than passing it', () => {
    // Wired to the REAL SPI default, not a stand-in that happens to return undefined: the claim is
    // about what `Realm` does out of the box, and a hand-written fake would only prove I can write
    // one that agrees with me.
    const base = Realm.prototype.satisfies.bind(Realm.prototype);
    const errors = typecheckComposite(docs, 'full', (e, r) => base(e, r));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe(TypeErrorKind.UNJUDGED_REQUIREMENT);
  });

  it('really is the shipped default, not a value this test supplied', () => {
    expect(Realm.prototype.satisfies({ signedIn: true }, { signedIn: true })).toBeUndefined();
  });

  it('is not the same as a realm that judged and said NO', () => {
    // The distinction is the product: "I cannot tell" sends you to teach the realm, "no" sends you
    // to reorder the composite. Collapsing them would hide which of those is needed.
    const errors = typecheckComposite(docs, 'full', () => false);
    expect(errors[0]?.kind).toBe(TypeErrorKind.UNSATISFIED_REQUIREMENT);
  });

  it('is not the same as a realm that judged and said YES', () => {
    expect(typecheckComposite(docs, 'full', () => true)).toEqual([]);
  });
});
