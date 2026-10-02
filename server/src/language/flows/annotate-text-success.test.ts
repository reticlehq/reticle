/**
 * An app whose only observable is rendered text can save an asserted flow (#811).
 *
 * `reticle_annotate`'s success-state accepted signal | statePath(+store) | net | console(+absent) |
 * testid. An app with none of those — no testids, no `reticle.signal`, no registrable store, no
 * network call on the interaction under test — could not produce an asserted flow AT ALL. The
 * reporter's case was a discount price computed and rendered, verified without editing the app's
 * source, so adding a testid or a signal was not available either.
 *
 * They reported the flow honestly as `assertion-free` rather than bolting on a meaningless
 * `console absent` to flip the grade. That is the right call, and it is why the vocabulary had to
 * widen instead of the reporter working around it: a flow with no assertion is a permanent green,
 * and derived-DOM rendering (prices, totals, formatted dates, computed labels) is a large share of
 * what actually breaks in a UI.
 */
import { describe, it, expect } from 'vitest';
import {
  AnnotationKind,
  AnnotationTarget,
  flowExpectHasConsequence,
  flowExpectIsPresenceOnly,
  type Annotation,
  type AnnotateResult,
} from '@reticlehq/core';
import { compileAnnotation, describeCompiled } from './annotate-notes/annotate.js';

function annotate(a: Annotation, steps = 1) {
  return compileAnnotation(a, steps);
}

/** Narrow to the success branch, so a regression that starts refusing fails here rather than later. */
function okResult(a: Annotation, steps = 1): Extract<AnnotateResult, { ok: true }> {
  const { result } = compileAnnotation(a, steps);
  if (!result.ok) throw new Error(`expected an ok annotation, got ${result.code}`);
  return result;
}

const PRICE: Annotation = {
  kind: AnnotationKind.SUCCESS_STATE,
  text: { contains: '$17.99' },
};

describe('a rendered value can be a success state', () => {
  it('compiles to a flow-level success', () => {
    expect(okResult(PRICE).target).toBe(AnnotationTarget.FLOW);
    expect(annotate(PRICE).patch?.success).toMatchObject({ kind: 'text', contains: '$17.99' });
  });

  it('carries scope, absent and visible through, as the assert surface accepts them', () => {
    const out = annotate({
      kind: AnnotationKind.SUCCESS_STATE,
      text: { contains: 'Saved', scope: '[role=dialog]', visible: true },
    });
    expect(out.patch?.success).toMatchObject({
      kind: 'text',
      contains: 'Saved',
      scope: '[role=dialog]',
      visible: true,
    });
  });

  it('says what it attached, so the author can see which gate they just made', () => {
    expect(describeCompiled(PRICE)).toContain('$17.99');
    expect(describeCompiled(PRICE)).toContain('text shows');
  });

  it('describes an absence check as an absence, not as a showing', () => {
    const gone: Annotation = {
      kind: AnnotationKind.SUCCESS_STATE,
      text: { contains: 'Unsaved changes', absent: true },
    };
    expect(describeCompiled(gone)).toContain('text is gone');
  });
});

describe('the grade it earns is presence-only, and honestly so', () => {
  it('is not a consequence — text is read from the DOM', () => {
    // A locator healed to the wrong element can still satisfy it, which is exactly the distinction
    // `ConsequenceKind` exists to keep. Claiming otherwise would be a stronger lie than the gap.
    expect(flowExpectHasConsequence({ kind: 'text', contains: '$17.99' })).toBe(false);
  });

  it('IS presence-only, so it does not fall through to assertion-free', () => {
    // The expensive omission this guards: a text-only expect that counted as neither would grade
    // assertion-free — a permanent green wearing an assertion.
    expect(flowExpectIsPresenceOnly({ kind: 'text', contains: '$17.99' })).toBe(true);
  });

  it('warns the author that it is presence-only rather than letting them assume otherwise', () => {
    expect(okResult(PRICE).note).toContain('presence-only');
  });
});
