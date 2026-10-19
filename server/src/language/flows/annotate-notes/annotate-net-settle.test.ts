/**
 * A saved `net { count }` check gates on a NETWORK settle, not a whole-page settle: the gate is there
 * so a late duplicate request is counted, and DOM churn from an animation must not hold it open
 * (a flaky red seen as a merge-queue bench ejection on 2026-10-19).
 */
import { describe, expect, it } from 'vitest';
import { AnnotationKind } from '@reticlehq/core';
import { compileAnnotation } from './annotate.js';

describe('a counted network annotation', () => {
  it('gates the count on a network-scoped settle', () => {
    const outcome = compileAnnotation(
      { kind: AnnotationKind.SUCCESS_STATE, net: { urlContains: '/api/x', count: 0 } },
      2,
    );
    expect(JSON.stringify(outcome)).toContain('"kind":"settled","channel":"network"');
  });
});
