import { describe, expect, it } from 'vitest';
import { Verified } from '@reticlehq/core';
import { offerToKeep, type SequenceGrade } from './sequence-grade.js';

/**
 * A plan that proved something is worth keeping. One that proved nothing is not.
 *
 * A completed sequence is already a compiled program — anchors resolved, actions ordered, and, where
 * a step declared one, a consequence. That is a flow, minus somebody deciding to save it. The agent
 * has the whole thing in hand at exactly the moment it is cheapest to keep, and then throws it away.
 *
 * The gate is the part that matters: **no consequence, no save.** A plan where every step drove and
 * none declared replays green whatever the app does, so offering to keep it would manufacture
 * regression coverage that cannot go red — the same false green `unverifiable` already names on the
 * suite, arriving a step earlier. Offering only what held is what makes the offer mean anything.
 */

const grade = (
  verified: SequenceGrade['verified'],
  declared: number,
  total: number,
): SequenceGrade => ({ verified, declared, total, because: '' });

describe('whether a driven plan is worth saving as a flow', () => {
  it('offers to keep a plan whose declared consequences all held', () => {
    expect(offerToKeep(grade(Verified.YES, 2, 3))).toBeDefined();
  });

  it('says how to keep it, so the offer costs no second round trip', () => {
    expect(offerToKeep(grade(Verified.YES, 2, 3))).toMatch(/reticle_flow_save/);
  });

  it('does NOT offer a plan where nothing was declared', () => {
    // It replays green whatever the app does. Keeping it would manufacture coverage that cannot fail.
    expect(offerToKeep(grade(Verified.UNKNOWN, 0, 3))).toBeUndefined();
  });

  it('does NOT offer a plan whose consequence did not hold', () => {
    // The journey is not one anybody wants to re-run yet — it is the bug report.
    expect(offerToKeep(grade(Verified.NO, 1, 3))).toBeUndefined();
  });

  it('does NOT offer an empty plan', () => {
    expect(offerToKeep(grade(Verified.UNKNOWN, 0, 0))).toBeUndefined();
  });

  it('names how much of the plan is actually covered, so the offer is not oversold', () => {
    // Saving 2-of-12 as a regression flow is a real thing to do and a bad thing to do unknowingly.
    expect(offerToKeep(grade(Verified.YES, 2, 12))).toMatch(/2 of 12/);
  });
});
