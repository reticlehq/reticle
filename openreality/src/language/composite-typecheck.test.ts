import { describe, it, expect } from 'vitest';
import { typecheckComposite, TypeErrorKind } from './typecheck.js';

/**
 * A composite is refused as a DOCUMENT, before an action is spent.
 *
 * Same rule the capability check already applies, extended to composition: a journey that cannot
 * run should be refused by reading it, not discovered at step 7 of something that has already
 * half-happened and cannot be un-happened. A cycle discovered at runtime is an infinite replay; a
 * missing sub-document discovered at runtime is a journey abandoned midway with the subject left
 * wherever it got to.
 */

const doc = (name: string, invokes: string[] = []) => ({
  name,
  steps: invokes.map((invoke, i) => ({ id: `s${String(i)}`, invoke, at: i })),
});

describe('typechecking a composite', () => {
  it('accepts a tree that resolves', () => {
    const errors = typecheckComposite(
      [
        doc('onboarding/full', ['onboarding/signup', 'onboarding/pay']),
        doc('onboarding/signup'),
        doc('onboarding/pay'),
      ],
      'onboarding/full',
    );
    expect(errors).toEqual([]);
  });

  it('names an invoke that resolves to nothing', () => {
    const errors = typecheckComposite([doc('a', ['b'])], 'a');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe(TypeErrorKind.UNRESOLVED_FLOW);
    expect(errors[0]?.detail).toContain('b');
  });

  it('names a cycle, with the path that closes it', () => {
    const errors = typecheckComposite([doc('a', ['b']), doc('b', ['c']), doc('c', ['a'])], 'a');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe(TypeErrorKind.CYCLIC_INVOCATION);
    // The path is the whole value of the message: "there is a cycle" sends somebody reading three
    // documents to find what this already knows.
    expect(errors[0]?.detail).toContain('a → b → c → a');
  });

  it('catches a document that invokes itself', () => {
    const errors = typecheckComposite([doc('a', ['a'])], 'a');
    expect(errors[0]?.kind).toBe(TypeErrorKind.CYCLIC_INVOCATION);
  });

  it('reports a diamond ONCE as fine, not as a cycle', () => {
    // Two paths to the same leaf is reuse, which is the point of composition — not recursion.
    const errors = typecheckComposite(
      [doc('top', ['left', 'right']), doc('left', ['leaf']), doc('right', ['leaf']), doc('leaf')],
      'top',
    );
    expect(errors).toEqual([]);
  });

  it('refuses an entry document that does not exist', () => {
    expect(typecheckComposite([doc('a')], 'missing')[0]?.kind).toBe(TypeErrorKind.UNRESOLVED_FLOW);
  });
});
