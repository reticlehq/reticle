import { describe, expect, it } from 'vitest';
import { AnnotationKind, AnnotationSchema } from '@syrin/iris-protocol';

/**
 * Zod validation. The structured discriminated union accepts only the
 * four shipped kinds with their required fields, and REJECTS a free natural-language string. That
 * rejection is the FIRST-CUT boundary: NL → predicate compilation is FUTURE, never guessed.
 */
describe('AnnotationSchema structured validation', () => {
  it('an unknown kind is rejected', () => {
    expect(AnnotationSchema.safeParse({ kind: 'lol', x: 1 }).success).toBe(false);
  });

  it('assert-signal with an empty name is rejected', () => {
    expect(
      AnnotationSchema.safeParse({ kind: AnnotationKind.ASSERT_SIGNAL, name: '' }).success,
    ).toBe(false);
  });

  it('assert-visible with no testid is rejected', () => {
    expect(AnnotationSchema.safeParse({ kind: AnnotationKind.ASSERT_VISIBLE }).success).toBe(false);
  });

  it('a free natural-language string is rejected (NOT compiled) — first-cut boundary', () => {
    expect(AnnotationSchema.safeParse('the diff should appear').success).toBe(false);
  });

  it('a well-formed assert-signal parses (positive control)', () => {
    expect(
      AnnotationSchema.safeParse({ kind: AnnotationKind.ASSERT_SIGNAL, name: 'diff:shown' })
        .success,
    ).toBe(true);
  });
});
