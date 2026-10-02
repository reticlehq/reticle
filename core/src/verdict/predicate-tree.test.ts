/**
 * A saved flow must not keep an address that only meant something in the session that wrote it.
 *
 * Storing the predicate verbatim is what made this reachable: the flat v1 struct had no slot for a
 * `scope` or a `target`, so a ref could never reach disk. A ref is one session's numbering — `e12`
 * is whatever that session handed out twelfth — and on replay it resolves to nothing or to some
 * other element. For an ABSENCE check the first of those is a green by construction: a scope that
 * resolves to nothing satisfies `absent` (predicate-element.ts), so the step could never go red.
 */
import { describe, expect, it } from 'vitest';
import { FlowFileSchema } from '@/artifacts/flow-types.js';
import { PredicateKind } from './consequence.js';
import type { Predicate } from './predicate.js';
import { sessionBoundField } from './predicate-tree.js';

const fileWith = (assertion: unknown): unknown => ({
  version: 2,
  name: 'checkout',
  createdAt: 1,
  steps: [
    { tool: 'reticle_act', anchor: { kind: 'testid', value: 'pay' }, args: {}, expect: assertion },
  ],
});

const refScopedAbsence: Predicate = {
  kind: PredicateKind.TEXT,
  contains: 'Error',
  absent: true,
  scope: 'e12',
};

describe('sessionBoundField', () => {
  it('names a text scope that is a ref', () => {
    expect(sessionBoundField(refScopedAbsence)).toBe('text.scope "e12"');
  });

  it('names an element query scoped to a ref', () => {
    const p: Predicate = {
      kind: PredicateKind.ELEMENT,
      query: { role: 'dialog', scope: 'e4' },
      absent: true,
    };
    expect(sessionBoundField(p)).toBe('element.query.scope "e4"');
  });

  it('names an animation targeted at a ref', () => {
    expect(
      sessionBoundField({ kind: PredicateKind.ANIMATION, target: 'e7', completed: true }),
    ).toBe('animation.target "e7"');
  });

  // Unlike the top-level readers beside it, this walk is DEEP: a ref under a `not` or an `anyOf`
  // is exactly as meaningless on replay as one at the top.
  it('finds a ref at any depth', () => {
    const nested: Predicate = {
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.SETTLED },
        {
          kind: PredicateKind.NOT,
          predicate: { kind: PredicateKind.ANY_OF, predicates: [refScopedAbsence] },
        },
      ],
    };
    expect(sessionBoundField(nested)).toBe('text.scope "e12"');
  });

  it('leaves a CSS selector alone — it names the same element in every session', () => {
    expect(sessionBoundField({ ...refScopedAbsence, scope: '#modal' })).toBeUndefined();
    expect(sessionBoundField({ kind: PredicateKind.ANIMATION, target: 'e7x' })).toBeUndefined();
  });
});

describe('a flow file refuses a session-bound expect, and says which field', () => {
  it('refuses a ref-scoped absence check', () => {
    const parsed = FlowFileSchema.safeParse(fileWith(refScopedAbsence));
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : JSON.stringify(parsed.error.issues);
    expect(messages).toContain('text.scope \\"e12\\"');
  });

  it('refuses it inside a precondition too', () => {
    const file = { ...(fileWith(undefined) as object), requires: [refScopedAbsence] };
    expect(FlowFileSchema.safeParse(file).success).toBe(false);
  });

  it('keeps the same check scoped by selector', () => {
    expect(
      FlowFileSchema.safeParse(fileWith({ ...refScopedAbsence, scope: '#modal' })).success,
    ).toBe(true);
  });
});
