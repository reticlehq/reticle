/**
 * `assert-net` is documented and was not implemented — the worst possible pairing.
 *
 * agent-cheatsheet.md tells an agent that when a saved flow grades below `asserted`, it should
 * "add a consequence (reticle_annotate assert-signal/assert-net or a success-state) so it can't pass
 * while broken". There was no such kind. The call returned `annotate_unknown_kind`, the annotation
 * was dropped, the flow stayed `presence-only` — and a presence-only flow is precisely one that CAN
 * pass while broken. Our own documentation was manufacturing the false green the product exists to
 * catch, and it does it silently: nothing downstream says "your gate never got attached".
 *
 * Everything underneath already existed. `FlowExpect.net` carries method/urlContains/status and the
 * exact `count` cardinality check the replay engine evaluates (the double-submit oracle). Only the
 * annotation kind that reaches it was missing, so this closes the gap rather than inventing a
 * capability: the documented sentence becomes true.
 */

import { describe, expect, it } from 'vitest';
import { AnnotationKind, AnnotationTarget } from '@reticlehq/core';
import { compileAnnotation } from './annotate.js';

const ONE_STEP = 1;

describe('assert-net', () => {
  it('compiles to the step expectation the replay engine already evaluates', () => {
    const out = compileAnnotation(
      { kind: AnnotationKind.ASSERT_NET, net: { method: 'POST', urlContains: '/refund' } },
      ONE_STEP,
    );
    expect(out.result.ok).toBe(true);
    // Narrow before reading `target`: the failure arm of AnnotateResult has no such field, and the
    // union is what stops a test from asserting on a shape the code can never return.
    if (!out.result.ok) throw new Error('expected the annotation to compile');
    expect(out.result.target).toBe(AnnotationTarget.STEP);
    expect(out.patch?.stepExpect?.net).toEqual({ method: 'POST', urlContains: '/refund' });
  });

  /**
   * The reason this kind is worth having at all: "the request fired" is not the assertion that
   * catches a double submit. `count` turns presence into cardinality, and it must survive the
   * annotation path intact or the strongest net oracle is unreachable from an agent.
   */
  it('carries an exact count through, so the double-submit oracle is reachable', () => {
    const out = compileAnnotation(
      {
        kind: AnnotationKind.ASSERT_NET,
        net: { method: 'POST', urlContains: '/refund', count: 1 },
      },
      ONE_STEP,
    );
    expect(out.patch?.stepExpect?.net?.count).toBe(1);
  });

  it('refuses to attach to a flow with no steps, like every other step-level kind', () => {
    const out = compileAnnotation(
      { kind: AnnotationKind.ASSERT_NET, net: { urlContains: '/x' } },
      0,
    );
    expect(out.result.ok).toBe(false);
  });
});
