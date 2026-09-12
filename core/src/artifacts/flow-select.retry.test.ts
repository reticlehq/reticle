import { describe, it, expect } from 'vitest';
import { shouldRetry } from './flow-select.js';

/**
 * Retrying everything is waste; retrying nothing calls a flake a regression.
 *
 * This is the item that was deliberately held back until there was a flake ledger to ask, because
 * without one "retry on failure" is retry-everything with extra steps: a genuinely broken flow gets
 * run three times to fail three times, and the suite pays triple to learn what it knew after the
 * first attempt.
 *
 * The ledger answers the only question that makes retry honest: has this flow ever passed and failed
 * on UNCHANGED code? A flow that has only ever failed is not flaky, it is broken, and re-running it
 * is how a suite turns a real regression into a slow one.
 */
describe('shouldRetry', () => {
  const flaky = { runs: 20, fails: 4 };
  const alwaysFails = { runs: 20, fails: 20 };
  const alwaysPasses = { runs: 20, fails: 0 };

  it('retries a flow the ledger has seen both pass and fail', () => {
    expect(shouldRetry({ attempts: 2, on: 'flake-classified' }, flaky, 0)).toBe(true);
  });

  it('does NOT retry a flow that has only ever failed — that is broken, not flaky', () => {
    expect(shouldRetry({ attempts: 2, on: 'flake-classified' }, alwaysFails, 0)).toBe(false);
  });

  it('does NOT retry a flow with no history — nothing has classified it yet', () => {
    expect(shouldRetry({ attempts: 2, on: 'flake-classified' }, undefined, 0)).toBe(false);
  });

  it('stops at the declared attempt count, so a flake cannot spin forever', () => {
    expect(shouldRetry({ attempts: 2, on: 'flake-classified' }, flaky, 1)).toBe(false);
  });

  it('`on: "any"` retries without asking the ledger — opt-in, and the caller owns the cost', () => {
    expect(shouldRetry({ attempts: 2, on: 'any' }, alwaysFails, 0)).toBe(true);
    expect(shouldRetry({ attempts: 2, on: 'any' }, undefined, 0)).toBe(true);
  });

  it('no policy means no retry — silence is never an opt-in', () => {
    expect(shouldRetry(undefined, flaky, 0)).toBe(false);
  });

  it('never retries a flow that always passes — there is nothing to re-attempt', () => {
    expect(shouldRetry({ attempts: 2, on: 'flake-classified' }, alwaysPasses, 0)).toBe(false);
  });
});
