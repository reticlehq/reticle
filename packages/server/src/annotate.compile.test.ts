import { describe, expect, it } from 'vitest';
import { AnnotationErrorCode, AnnotationKind, AnnotationTarget } from '@syrin/protocol';
import type { Annotation } from '@syrin/protocol';
import { compileAnnotation, describeCompiled } from './annotate.js';

/**
 * M8 Stage B ANNOTATE — pure compiler matrix (A). No IO, no clock: compileAnnotation maps a
 * structured annotation + the current step count → an AnnotateOutcome (result + patch). These are
 * the in-scope, FIRST-CUT structured kinds only; free NL → predicate is FUTURE (see B4).
 */
describe('compileAnnotation (M8 Stage B ANNOTATE pure compiler)', () => {
  it('A1: assert-signal compiles to step.expect.signal on the LAST step', () => {
    const a: Annotation = { kind: AnnotationKind.ASSERT_SIGNAL, name: 'diff:shown' };
    const out = compileAnnotation(a, 3);
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) throw new Error('expected ok');
    expect(out.result.target).toBe(AnnotationTarget.STEP);
    expect(out.patch?.stepIndex).toBe(2);
    expect(out.patch?.stepExpect?.signal).toBe('diff:shown');
  });

  it('A2: assert-signal carries dataMatches into signalData', () => {
    const a: Annotation = {
      kind: AnnotationKind.ASSERT_SIGNAL,
      name: 'diff:shown',
      dataMatches: { count: 2 },
    };
    const out = compileAnnotation(a, 1);
    expect(out.patch?.stepExpect?.signalData).toEqual({ count: 2 });
  });

  it('A3: assert-visible compiles to expect.element.testid on the last step', () => {
    const a: Annotation = { kind: AnnotationKind.ASSERT_VISIBLE, testid: 'diff-panel' };
    const out = compileAnnotation(a, 2);
    expect(out.result.ok).toBe(true);
    expect(out.patch?.stepIndex).toBe(1);
    expect(out.patch?.stepExpect?.element?.testid).toBe('diff-panel');
  });

  it('A4: mark-dynamic compiles to a flow-level dynamicAdd (no stepExpect)', () => {
    const a: Annotation = { kind: AnnotationKind.MARK_DYNAMIC, testid: 'caption-text' };
    const out = compileAnnotation(a, 5);
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) throw new Error('expected ok');
    expect(out.result.target).toBe(AnnotationTarget.FLOW);
    expect(out.patch?.dynamicAdd).toBe('caption-text');
    expect(out.patch?.stepExpect).toBeUndefined();
  });

  it('A5: success-state with a signal sets flow.success.signal', () => {
    const a: Annotation = { kind: AnnotationKind.SUCCESS_STATE, signal: 'diff:shown' };
    const out = compileAnnotation(a, 4);
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) throw new Error('expected ok');
    expect(out.result.target).toBe(AnnotationTarget.FLOW);
    expect(out.patch?.success?.signal).toBe('diff:shown');
  });

  it('A6: success-state with a testid sets flow.success.element.testid', () => {
    const a: Annotation = { kind: AnnotationKind.SUCCESS_STATE, testid: 'done' };
    const out = compileAnnotation(a, 4);
    expect(out.patch?.success?.element?.testid).toBe('done');
    expect(out.patch?.success?.signal).toBeUndefined();
  });

  it('A7: an assert-* on zero steps is NO_STEP_TO_ANNOTATE (no patch)', () => {
    const a: Annotation = { kind: AnnotationKind.ASSERT_SIGNAL, name: 'x' };
    const out = compileAnnotation(a, 0);
    expect(out.result.ok).toBe(false);
    if (out.result.ok) throw new Error('expected not ok');
    expect(out.result.code).toBe(AnnotationErrorCode.NO_STEP_TO_ANNOTATE);
    expect(out.patch).toBeUndefined();
  });

  it('A8: mark-dynamic is allowed with zero steps (flow-level, no step needed)', () => {
    const a: Annotation = { kind: AnnotationKind.MARK_DYNAMIC, testid: 'caption-text' };
    const out = compileAnnotation(a, 0);
    expect(out.result.ok).toBe(true);
    expect(out.patch?.dynamicAdd).toBe('caption-text');
  });

  it('A9: success-state with neither signal nor testid is MISSING_FIELD', () => {
    const a: Annotation = { kind: AnnotationKind.SUCCESS_STATE };
    const out = compileAnnotation(a, 4);
    expect(out.result.ok).toBe(false);
    if (out.result.ok) throw new Error('expected not ok');
    expect(out.result.code).toBe(AnnotationErrorCode.MISSING_FIELD);
  });

  it('A10: success-state with BOTH signal and testid prefers signal (documented)', () => {
    const a: Annotation = { kind: AnnotationKind.SUCCESS_STATE, signal: 'diff:shown', testid: 'd' };
    const out = compileAnnotation(a, 4);
    expect(out.result.ok).toBe(true);
    expect(out.patch?.success?.signal).toBe('diff:shown');
    expect(out.patch?.success?.element).toBeUndefined();
  });

  it('A11: describeCompiled renders the human confirmation text', () => {
    expect(describeCompiled({ kind: AnnotationKind.ASSERT_SIGNAL, name: 'diff:shown' })).toBe(
      'will assert signal diff:shown',
    );
    expect(describeCompiled({ kind: AnnotationKind.ASSERT_VISIBLE, testid: 'diff-panel' })).toBe(
      'will assert diff-panel visible',
    );
    expect(describeCompiled({ kind: AnnotationKind.MARK_DYNAMIC, testid: 'caption-text' })).toBe(
      'will ignore caption-text (dynamic)',
    );
    expect(describeCompiled({ kind: AnnotationKind.SUCCESS_STATE, signal: 'diff:shown' })).toBe(
      'will succeed when signal diff:shown',
    );
    expect(describeCompiled({ kind: AnnotationKind.SUCCESS_STATE, testid: 'done' })).toBe(
      'will succeed when done visible',
    );
  });
});
