import { describe, it, expect } from 'vitest';
import { formatStepAddress, typecheckComposite, TypeErrorKind } from './typecheck.js';

/**
 * Where did it fail? — the deliverable composition exists for.
 *
 * A flat recording that drifts reports an INDEX, and an index in a composite answers nothing: step 2
 * of which document, reached how? Two journeys that share a sub-flow produce the same number for
 * different failures, and a reader has to open every document to find out which one moved.
 *
 * An address is the document, the step inside it, and the chain of invocations that reached it. It
 * is what lets repair be narrow — heal the sub-flow that actually moved and every caller inherits
 * the fix — and it is the reason nesting is worth its cost at all.
 */

const doc = (name: string, invokes: string[] = [], requires?: unknown, ensures?: unknown) => ({
  name,
  requires,
  ensures,
  steps: invokes.map((invoke, i) => ({ id: `s${String(i)}`, invoke, at: i })),
});

describe('a step address', () => {
  it('reads as document#step, outermost invocation last', () => {
    expect(
      formatStepAddress({
        flow: 'onboarding/signup',
        step: 2,
        via: [{ flow: 'onboarding/full', step: 1 }],
      }),
    ).toBe('onboarding/signup#2 (invoked from onboarding/full#1)');
  });

  it('names a whole chain, nearest caller first', () => {
    expect(
      formatStepAddress({
        flow: 'c',
        step: 0,
        via: [
          { flow: 'b', step: 3 },
          { flow: 'a', step: 1 },
        ],
      }),
    ).toBe('c#0 (invoked from b#3, a#1)');
  });

  it('is just document#step at the top level', () => {
    expect(formatStepAddress({ flow: 'checkout', step: 4, via: [] })).toBe('checkout#4');
  });
});

describe('a composite failure carries its address', () => {
  it('names the document the unresolved invoke was written in, not just an index', () => {
    const errors = typecheckComposite([doc('a', ['b'])], 'a');
    expect(errors[0]?.at?.flow).toBe('a');
    expect(errors[0]?.at?.step).toBe(0);
    expect(errors[0]?.at?.via).toEqual([]);
  });

  it('carries the chain for a failure nested two deep', () => {
    // `missing` is invoked from `mid`, which `top` invoked. The error must say so — reporting
    // "step 0" is true of all three documents and useful about none of them.
    const errors = typecheckComposite([doc('top', ['mid']), doc('mid', ['missing'])], 'top');
    expect(errors).toHaveLength(1);
    expect(formatStepAddress(errors[0]?.at ?? { flow: '?', step: 0, via: [] })).toBe(
      'mid#0 (invoked from top#0)',
    );
  });

  it('addresses a failed stitch to the document that could not be entered', () => {
    const errors = typecheckComposite(
      [doc('full', ['pay']), doc('pay', [], { signedIn: true })],
      'full',
      () => false,
    );
    expect(errors[0]?.kind).toBe(TypeErrorKind.UNSATISFIED_REQUIREMENT);
    // The address is the CALL SITE — the step that tried to enter `pay` — because that is where a
    // fix goes: reorder the composite, or establish what `pay` needs before invoking it.
    expect(formatStepAddress(errors[0]?.at ?? { flow: '?', step: 0, via: [] })).toBe('full#0');
  });

  it('keeps the bare `step` index, so nothing reading it today breaks', () => {
    expect(typecheckComposite([doc('a', ['b'])], 'a')[0]?.step).toBe(0);
  });
});
