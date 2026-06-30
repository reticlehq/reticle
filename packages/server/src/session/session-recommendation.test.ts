import { describe, expect, it } from 'vitest';
import { UNSCRIPTABLE_TAB_RECOMMENDATION } from '@reticle/protocol';
import { buildSessionRecommendation } from './session-recommendation.js';

describe('buildSessionRecommendation', () => {
  it('recommends reticle drive when hidden and throttled', () => {
    const rec = buildSessionRecommendation({ hidden: true, throttled: true, focused: false });
    expect(rec).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
    expect(rec).toContain('reticle drive');
  });

  it('recommends when throttled even if not hidden', () => {
    expect(buildSessionRecommendation({ hidden: false, throttled: true, focused: true })).toBe(
      UNSCRIPTABLE_TAB_RECOMMENDATION,
    );
  });

  it('recommends when hidden regardless of throttled flag', () => {
    expect(buildSessionRecommendation({ hidden: true, throttled: false, focused: false })).toBe(
      UNSCRIPTABLE_TAB_RECOMMENDATION,
    );
  });

  it('returns undefined for a healthy focused tab', () => {
    expect(
      buildSessionRecommendation({ hidden: false, throttled: false, focused: true }),
    ).toBeUndefined();
  });

  it('does not recommend for a merely-unfocused but live tab', () => {
    expect(
      buildSessionRecommendation({ hidden: false, throttled: false, focused: false }),
    ).toBeUndefined();
  });

  it('the recommendation is the named UNSCRIPTABLE_TAB_RECOMMENDATION constant', () => {
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toContain('reticle drive');
    expect(UNSCRIPTABLE_TAB_RECOMMENDATION).toContain('refocus');
  });
});
