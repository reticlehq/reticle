import { describe, expect, it } from 'vitest';
import { FADED_REASON_PREFIX, fadedReason, isFadedReason } from './faded-reason.js';

describe('fadedReason', () => {
  it('starts with the shared prefix and gives the opacity to two decimals', () => {
    expect(fadedReason(0.012)).toBe(`${FADED_REASON_PREFIX} 0.01`);
  });

  it('is recognised by isFadedReason, and a contrast reason is not', () => {
    expect(isFadedReason(fadedReason(0))).toBe(true);
    expect(isFadedReason('the contrast is 1.20')).toBe(false);
  });
});
