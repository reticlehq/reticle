import { describe, it, expect } from 'vitest';
import { ConsequenceKind, PresenceKind, isConsequenceKind, isPresenceKind } from './consequence.js';
import { flowExpectHasConsequence, flowExpectIsPresenceOnly } from '@/artifacts/flow-types.js';
import { PredicateKind } from './consequence.js';
import type { Predicate } from './predicate.js';

describe('consequence classification (the moat rule, single source)', () => {
  it('signal/net/state are consequences; element/text are presence', () => {
    for (const k of Object.values(ConsequenceKind)) {
      expect(isConsequenceKind(k)).toBe(true);
      expect(isPresenceKind(k)).toBe(false);
    }
    for (const k of Object.values(PresenceKind)) {
      expect(isPresenceKind(k)).toBe(true);
      expect(isConsequenceKind(k)).toBe(false);
    }
  });

  it('route/console/settled/animation are neither consequence nor presence', () => {
    for (const k of ['route', 'console', 'settled', 'animation']) {
      expect(isConsequenceKind(k)).toBe(false);
      expect(isPresenceKind(k)).toBe(false);
    }
  });

  it('flowExpectHasConsequence tracks any consequence field', () => {
    const signal: Predicate = { kind: PredicateKind.SIGNAL, name: 'saved' };
    const net: Predicate = { kind: PredicateKind.NET, urlContains: '/api' };
    const state: Predicate = { kind: PredicateKind.STATE, path: 'x', equals: 1 };
    const element: Predicate = { kind: PredicateKind.ELEMENT, query: { testid: 'ok' } };
    expect(flowExpectHasConsequence(signal)).toBe(true);
    expect(flowExpectHasConsequence(net)).toBe(true);
    expect(flowExpectHasConsequence(state)).toBe(true);
    expect(flowExpectHasConsequence(element)).toBe(false);
    expect(flowExpectHasConsequence(undefined)).toBe(false);
  });

  /*
   * The grade is about what a flow CAN prove, so a consequence nested in a composite counts exactly
   * as much as one at the top. Unreachable in v1 — the flat struct had no nesting — and the first
   * thing an agent writes in v2, because `allOf[settled, net]` is what a cardinality assertion
   * compiles to.
   */
  it('finds a consequence nested inside a composite', () => {
    const nested: Predicate = {
      kind: PredicateKind.ALL_OF,
      predicates: [
        { kind: PredicateKind.SETTLED },
        { kind: PredicateKind.NET, urlContains: '/api', count: 1 },
      ],
    };
    expect(flowExpectHasConsequence(nested)).toBe(true);
  });

  // A settle gate is a WAIT, not a claim. An expect that only settles has asserted nothing.
  it('does not read a settle gate as a consequence', () => {
    expect(flowExpectHasConsequence({ kind: PredicateKind.SETTLED })).toBe(false);
    expect(flowExpectIsPresenceOnly({ kind: PredicateKind.SETTLED })).toBe(false);
  });

  it('flowExpectIsPresenceOnly is element-only with no consequence', () => {
    const element: Predicate = { kind: PredicateKind.ELEMENT, query: { testid: 'ok' } };
    const mixed: Predicate = {
      kind: PredicateKind.ALL_OF,
      predicates: [element, { kind: PredicateKind.SIGNAL, name: 'saved' }],
    };
    const signal: Predicate = { kind: PredicateKind.SIGNAL, name: 'saved' };
    expect(flowExpectIsPresenceOnly(element)).toBe(true);
    expect(flowExpectIsPresenceOnly(mixed)).toBe(false);
    expect(flowExpectIsPresenceOnly(signal)).toBe(false);
    expect(flowExpectIsPresenceOnly(undefined)).toBe(false);
  });
});
