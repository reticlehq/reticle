import { describe, expect, it } from 'vitest';
import { AnnotationErrorCode, AnnotationKind, AnnotationTarget } from '@reticle/protocol';
import type { Annotation } from '@reticle/protocol';
import { compileAnnotation, describeCompiled } from './annotate.js';

/**
 * Pure compiler matrix. No IO, no clock: compileAnnotation maps a
 * structured annotation + the current step count → an AnnotateOutcome (result + patch). These are
 * the in-scope, FIRST-CUT structured kinds only; free NL → predicate is FUTURE.
 */
describe('compileAnnotation pure compiler', () => {
  it('assert-signal compiles to step.expect.signal on the LAST step', () => {
    const a: Annotation = { kind: AnnotationKind.ASSERT_SIGNAL, name: 'diff:shown' };
    const out = compileAnnotation(a, 3);
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) throw new Error('expected ok');
    expect(out.result.target).toBe(AnnotationTarget.STEP);
    expect(out.patch?.stepIndex).toBe(2);
    expect(out.patch?.stepExpect?.signal).toBe('diff:shown');
  });

  it('assert-signal carries dataMatches into signalData', () => {
    const a: Annotation = {
      kind: AnnotationKind.ASSERT_SIGNAL,
      name: 'diff:shown',
      dataMatches: { count: 2 },
    };
    const out = compileAnnotation(a, 1);
    expect(out.patch?.stepExpect?.signalData).toEqual({ count: 2 });
  });

  it('assert-visible compiles to expect.element.testid on the last step', () => {
    const a: Annotation = { kind: AnnotationKind.ASSERT_VISIBLE, testid: 'diff-panel' };
    const out = compileAnnotation(a, 2);
    expect(out.result.ok).toBe(true);
    expect(out.patch?.stepIndex).toBe(1);
    expect(out.patch?.stepExpect?.element?.testid).toBe('diff-panel');
  });

  it('mark-dynamic compiles to a flow-level dynamicAdd (no stepExpect)', () => {
    const a: Annotation = { kind: AnnotationKind.MARK_DYNAMIC, testid: 'caption-text' };
    const out = compileAnnotation(a, 5);
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) throw new Error('expected ok');
    expect(out.result.target).toBe(AnnotationTarget.FLOW);
    expect(out.patch?.dynamicAdd).toBe('caption-text');
    expect(out.patch?.stepExpect).toBeUndefined();
  });

  it('success-state with a signal sets flow.success.signal', () => {
    const a: Annotation = { kind: AnnotationKind.SUCCESS_STATE, signal: 'diff:shown' };
    const out = compileAnnotation(a, 4);
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) throw new Error('expected ok');
    expect(out.result.target).toBe(AnnotationTarget.FLOW);
    expect(out.patch?.success?.signal).toBe('diff:shown');
  });

  it('success-state with a testid sets flow.success.element.testid', () => {
    const a: Annotation = { kind: AnnotationKind.SUCCESS_STATE, testid: 'done' };
    const out = compileAnnotation(a, 4);
    expect(out.patch?.success?.element?.testid).toBe('done');
    expect(out.patch?.success?.signal).toBeUndefined();
  });

  it('success-state with a net.count sets flow.success.net (double-submit guard)', () => {
    const a: Annotation = {
      kind: AnnotationKind.SUCCESS_STATE,
      net: { method: 'POST', urlContains: '/api/generate-script', count: 1 },
    };
    const out = compileAnnotation(a, 4);
    expect(out.patch?.success?.net).toEqual({
      method: 'POST',
      urlContains: '/api/generate-script',
      count: 1,
    });
    expect(out.patch?.success?.signal).toBeUndefined();
    expect(describeCompiled(a)).toContain('exactly 1 net /api/generate-script');
  });

  it('success-state with a clean-console condition sets flow.success.console', () => {
    const a: Annotation = {
      kind: AnnotationKind.SUCCESS_STATE,
      console: { level: 'error', absent: true },
    };
    const out = compileAnnotation(a, 4);
    expect(out.patch?.success?.console).toEqual({ level: 'error', absent: true });
    expect(describeCompiled(a)).toContain('no console.error');
  });

  it('assert-state compiles to step.expect.state on the LAST step', () => {
    const a: Annotation = {
      kind: AnnotationKind.ASSERT_STATE,
      store: 'app',
      statePath: 'deployments.0.status',
      equals: 'live',
    };
    const out = compileAnnotation(a, 3);
    expect(out.patch?.stepIndex).toBe(2);
    expect(out.patch?.stepExpect?.state).toEqual({
      store: 'app',
      path: 'deployments.0.status',
      equals: 'live',
    });
    expect(describeCompiled(a)).toContain('assert state deployments.0.status');
  });

  it('assert-state on zero steps is NO_STEP_TO_ANNOTATE', () => {
    const a: Annotation = { kind: AnnotationKind.ASSERT_STATE, statePath: 'x' };
    const out = compileAnnotation(a, 0);
    expect(out.result.ok).toBe(false);
  });

  it('an assert-* on zero steps is NO_STEP_TO_ANNOTATE (no patch)', () => {
    const a: Annotation = { kind: AnnotationKind.ASSERT_SIGNAL, name: 'x' };
    const out = compileAnnotation(a, 0);
    expect(out.result.ok).toBe(false);
    if (out.result.ok) throw new Error('expected not ok');
    expect(out.result.code).toBe(AnnotationErrorCode.NO_STEP_TO_ANNOTATE);
    expect(out.patch).toBeUndefined();
  });

  it('mark-dynamic is allowed with zero steps (flow-level, no step needed)', () => {
    const a: Annotation = { kind: AnnotationKind.MARK_DYNAMIC, testid: 'caption-text' };
    const out = compileAnnotation(a, 0);
    expect(out.result.ok).toBe(true);
    expect(out.patch?.dynamicAdd).toBe('caption-text');
  });

  it('success-state with a statePath sets flow.success.state (store-truth end-condition)', () => {
    const a: Annotation = {
      kind: AnnotationKind.SUCCESS_STATE,
      store: 'app',
      statePath: 'deployments.0.status',
      equals: 'live',
    };
    const out = compileAnnotation(a, 4);
    expect(out.patch?.success?.state).toEqual({
      store: 'app',
      path: 'deployments.0.status',
      equals: 'live',
    });
    expect(describeCompiled(a)).toContain('state deployments.0.status');
  });

  it('success-state precedence: signal beats statePath beats testid', () => {
    const a: Annotation = {
      kind: AnnotationKind.SUCCESS_STATE,
      signal: 'diff:shown',
      statePath: 'x',
      testid: 'd',
    };
    expect(compileAnnotation(a, 4).patch?.success?.signal).toBe('diff:shown');
    const b: Annotation = { kind: AnnotationKind.SUCCESS_STATE, statePath: 'x', testid: 'd' };
    expect(compileAnnotation(b, 4).patch?.success?.state?.path).toBe('x');
    expect(compileAnnotation(b, 4).patch?.success?.element).toBeUndefined();
  });

  it('success-state with neither signal nor statePath nor testid is MISSING_FIELD', () => {
    const a: Annotation = { kind: AnnotationKind.SUCCESS_STATE };
    const out = compileAnnotation(a, 4);
    expect(out.result.ok).toBe(false);
    if (out.result.ok) throw new Error('expected not ok');
    expect(out.result.code).toBe(AnnotationErrorCode.MISSING_FIELD);
  });

  it('success-state with BOTH signal and testid prefers signal (documented)', () => {
    const a: Annotation = { kind: AnnotationKind.SUCCESS_STATE, signal: 'diff:shown', testid: 'd' };
    const out = compileAnnotation(a, 4);
    expect(out.result.ok).toBe(true);
    expect(out.patch?.success?.signal).toBe('diff:shown');
    expect(out.patch?.success?.element).toBeUndefined();
  });

  it('intent compiles to a flow-level patch and is allowed with 0 captured steps', () => {
    const a: Annotation = { kind: AnnotationKind.INTENT, text: 'ship a deploy to production' };
    const out = compileAnnotation(a, 0);
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) throw new Error('expected ok');
    expect(out.result.target).toBe(AnnotationTarget.FLOW);
    expect(out.patch?.intent).toBe('ship a deploy to production');
  });

  it('describeCompiled renders the human confirmation text', () => {
    expect(describeCompiled({ kind: AnnotationKind.ASSERT_SIGNAL, name: 'diff:shown' })).toBe(
      'will assert signal diff:shown',
    );
    expect(
      describeCompiled({ kind: AnnotationKind.INTENT, text: 'ship a deploy to production' }),
    ).toBe('will intent: ship a deploy to production');
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
