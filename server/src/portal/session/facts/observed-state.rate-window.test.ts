import { describe, expect, it } from 'vitest';
import { BlindSpotKind } from '@reticlehq/core';
import { ObservedState } from './observed-state.js';

/**
 * Bridge sampling is a fact about the session AND a gap in the window it happened in, and those are
 * two different readings (#1414). The running total stays the session-wide blind spot; a window
 * sees only the drops inside it.
 */
describe('rate-limit drops are kept by when they happened', () => {
  it('counts only the drops at or after a window start', () => {
    const state = new ObservedState();
    state.noteRateLimited(40, 120); // a burst in the first second
    state.noteRateLimited(90, 640);
    state.noteRateLimited(95, 12_300); // five more, twelve seconds later

    expect(state.rateDroppedSince(0)).toBe(95);
    expect(state.rateDroppedSince(10_000)).toBe(5);
    expect(state.rateDroppedSince(13_000)).toBe(0);
  });

  it('counts a drop in the same second as the window start, erring toward unclean', () => {
    const state = new ObservedState();
    state.noteRateLimited(7, 4_100);
    expect(state.rateDroppedSince(4_900)).toBe(7);
  });

  it('keeps the session-wide count for coverage, and windows it when asked', () => {
    const state = new ObservedState();
    state.noteRateLimited(30, 200);

    expect(state.blindSpots()[BlindSpotKind.RATE_LIMITED]).toBe(30);
    expect(state.blindSpots(10_000)[BlindSpotKind.RATE_LIMITED]).toBe(0);
    expect(state.blindSpots(0)[BlindSpotKind.RATE_LIMITED]).toBe(30);
  });

  it('records nothing for a total that did not grow, or without a time', () => {
    const state = new ObservedState();
    state.noteRateLimited(10);
    expect(state.rateDroppedSince(0)).toBe(0);
    state.noteRateLimited(10, 500);
    expect(state.rateDroppedSince(0)).toBe(0);
  });
});
