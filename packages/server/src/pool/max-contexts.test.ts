/**
 * The pool's concurrency cap: explicit env wins (clamped), else scale with cpus under a hard ceiling
 * so a large machine never fans out into an unbounded number of headless contexts.
 */

import { describe, expect, it } from 'vitest';
import { resolveMaxContexts } from './playwright-launcher.js';

describe('resolveMaxContexts', () => {
  it('uses IRIS_MAX_CONTEXTS when set', () => {
    expect(resolveMaxContexts('3', 16)).toBe(3);
  });

  it('clamps an explicit value below 1 up to the cpu-based default', () => {
    // 0 is invalid → falls through to cpu scaling (4 cpus → 3).
    expect(resolveMaxContexts('0', 4)).toBe(3);
    expect(resolveMaxContexts('-5', 4)).toBe(3);
    expect(resolveMaxContexts('not-a-number', 4)).toBe(3);
  });

  it('scales with cpus minus one when no env is set', () => {
    expect(resolveMaxContexts(undefined, 4)).toBe(3);
    expect(resolveMaxContexts(undefined, 2)).toBe(1);
  });

  it('never exceeds the ceiling on a big box', () => {
    expect(resolveMaxContexts(undefined, 64)).toBe(8);
  });

  it('never goes below one even on a single-core box', () => {
    expect(resolveMaxContexts(undefined, 1)).toBe(1);
  });

  it('an explicit value above the ceiling is honored (operator override)', () => {
    expect(resolveMaxContexts('20', 4)).toBe(20);
  });
});
