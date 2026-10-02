import { describe, expect, it } from 'vitest';
import { classifyFlowAssertions, FlowAssertionGrade } from './flow-classify.js';
import type { FlowFile } from '@reticlehq/core';

/**
 * A composite is as asserted as what it invokes.
 *
 * Driving one showed the gap: `demo-full` invokes `demo/signin`, `demo/signin` asserts a signal, and
 * the composite still graded `assertion-free` with "it claims to verify a goal it cannot actually
 * check". That warning was correct about the FILE — the invoke step carries no `expect` — and wrong
 * about the JOURNEY, which asserts exactly once, in the document that owns the steps.
 *
 * Left alone it pushes people the wrong way: either duplicate the sub-flow's assertion into every
 * caller, which is the copy-paste composition exists to remove, or learn to ignore the warning,
 * which is how an honest one stops being read.
 *
 * An unresolvable sub-flow is NOT credited. Same direction as every other "cannot tell" in this
 * codebase: absence of evidence is not evidence, and crediting an assertion nobody has read would
 * grade a composite on a promise.
 */

const flow = (name: string, over: Partial<FlowFile> = {}): FlowFile =>
  ({ name, version: 1, steps: [], ...over }) as FlowFile;

const asserted = (name: string) =>
  flow(name, {
    steps: [
      {
        tool: 'reticle_act',
        anchor: { kind: 'testid', value: 'go' },
        expect: { kind: 'signal', name: 'done' },
      },
    ],
  });

const invokes = (name: string, target: string) =>
  flow(name, {
    intent: 'the journey works',
    steps: [{ tool: 'reticle_invoke', anchor: { kind: 'testid', value: target }, invoke: target }],
  });

describe('grading a composite', () => {
  it('credits the assertion of the flow it invokes', () => {
    const got = classifyFlowAssertions(
      invokes('full', 'signin'),
      new Map([['signin', asserted('signin')]]),
    );
    expect(got.grade).toBe(FlowAssertionGrade.ASSERTED);
    expect(got.hasConsequenceAssertion).toBe(true);
    expect(got.intentVerified).toBe(true);
    expect(got.warning).toBeUndefined();
  });

  it('does NOT credit a sub-flow it could not read', () => {
    const got = classifyFlowAssertions(invokes('full', 'signin'), new Map());
    expect(got.grade).toBe(FlowAssertionGrade.ASSERTION_FREE);
    expect(got.intentVerified).toBe(false);
  });

  it('does not credit a sub-flow that asserts nothing either', () => {
    const got = classifyFlowAssertions(
      invokes('full', 'empty'),
      new Map([['empty', flow('empty')]]),
    );
    expect(got.hasConsequenceAssertion).toBe(false);
  });

  it('credits through two levels', () => {
    const got = classifyFlowAssertions(
      invokes('top', 'mid'),
      new Map([
        ['mid', invokes('mid', 'leaf')],
        ['leaf', asserted('leaf')],
      ]),
    );
    expect(got.hasConsequenceAssertion).toBe(true);
  });

  it('survives a cycle instead of recursing forever', () => {
    const a = invokes('a', 'b');
    const b = invokes('b', 'a');
    expect(() =>
      classifyFlowAssertions(
        a,
        new Map([
          ['a', a],
          ['b', b],
        ]),
      ),
    ).not.toThrow();
  });

  it('grades a flat flow exactly as before when no map is given', () => {
    expect(classifyFlowAssertions(asserted('solo')).grade).toBe(FlowAssertionGrade.ASSERTED);
  });
});
