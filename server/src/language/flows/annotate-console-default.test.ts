import { describe, expect, it } from 'vitest';
import { AnnotationKind, PredicateKind, type Annotation } from '@reticlehq/core';
import { compileAnnotation, describeCompiled } from './annotate-notes/annotate.js';

/** #1674: A console success-state must match its stated default, not all console levels. */
describe('console success-state default (#1674)', () => {
  it('stores error as the default level when it is omitted', () => {
    const annotation: Annotation = {
      kind: AnnotationKind.SUCCESS_STATE,
      console: { absent: true },
    };

    const outcome = compileAnnotation(annotation, 0);

    expect(outcome.patch?.success).toEqual({
      kind: PredicateKind.CONSOLE,
      level: 'error',
      absent: true,
    });
    expect(describeCompiled(annotation)).toContain('no console.error');
  });

  it('keeps an explicitly requested console level', () => {
    const annotation: Annotation = {
      kind: AnnotationKind.SUCCESS_STATE,
      console: { level: 'warn', absent: true },
    };

    const outcome = compileAnnotation(annotation, 0);

    expect(outcome.patch?.success).toEqual({
      kind: PredicateKind.CONSOLE,
      level: 'warn',
      absent: true,
    });
    expect(describeCompiled(annotation)).toContain('no console.warn');
  });
});
