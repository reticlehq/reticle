/**
 * What the savings model claims, and why each claim survives being challenged.
 *
 * Reported by users: "we spend more time using Reticle than the time saved says we got back." The
 * model made that inevitable rather than measuring it. Minutes counted DEFECTS only — a verdict that
 * passed earned zero — so a user who drove for forty minutes and found two defects was shown eight
 * minutes saved, on a card grid that also shows real driving time. Two durations side by side with
 * no stated relationship is an invitation to subtract them, and the subtraction said Reticle costs
 * more than it returns.
 *
 * The old reasoning was written down and is the thing that is wrong: "a pass saves nothing by itself
 * - the run was going to pass either way". The counterfactual is not "it passes anyway". It is
 * "somebody checks it by hand, or nobody checks it and a false green ships". A PROVEN pass replaces
 * that manual check, and replacing it is the product.
 */

import { describe, expect, it } from 'vitest';
import { estimateImpactSavings, IMPACT_BASIS } from './impact-savings.js';
import { emptyImpactCounts } from './impact.js';
import type { ImpactCounts } from './impact.js';

const counts = (over: Partial<ImpactCounts>): ImpactCounts => ({
  ...emptyImpactCounts(),
  ...over,
});

describe('minutes saved', () => {
  it('credits a proven pass, because it replaced a check somebody would have made by hand', () => {
    const saved = estimateImpactSavings(counts({ verdicts: 10, failed: 0 })).minutes.value;
    expect(saved, 'ten proven consequences is not zero value').toBeGreaterThan(0);
  });

  it('credits a defect MORE than a pass — catching one saves the round trip as well', () => {
    const pass = estimateImpactSavings(counts({ verdicts: 1, failed: 0 })).minutes.value;
    const caught = estimateImpactSavings(counts({ verdicts: 1, failed: 1 })).minutes.value;
    expect(caught).toBeGreaterThan(pass);
  });

  it('scales with the work actually done, not with how broken the app happens to be', () => {
    // The old model's perverse incentive: the better your app, the less value Reticle appeared to
    // deliver. A healthy app being verified is the SUCCESS case, not the worthless one.
    const healthy = estimateImpactSavings(counts({ verdicts: 40, failed: 0 })).minutes.value;
    const broken = estimateImpactSavings(counts({ verdicts: 4, failed: 4 })).minutes.value;
    expect(healthy, 'forty proven consequences beats four defects in a tiny run').toBeGreaterThan(
      broken,
    );
  });

  it('stays zero before anything has been verified', () => {
    expect(estimateImpactSavings(emptyImpactCounts()).minutes.value).toBe(0);
  });

  it('says what it is measured against, and names BOTH parts', () => {
    // A number whose basis is unstated cannot be argued with, which is the same as not being
    // believed. The basis has to name the manual check and the re-prompt cycle, because the figure
    // is the sum of two different counterfactuals.
    expect(IMPACT_BASIS.MINUTES).toMatch(/hand|manual/i);
    expect(IMPACT_BASIS.MINUTES).toMatch(/re-?prompt|round trip/i);
  });
});

describe('tokens saved', () => {
  it('is net of what Reticle itself returned', () => {
    const gross = estimateImpactSavings(counts({ verdicts: 10 })).tokens.value;
    const net = estimateImpactSavings(counts({ verdicts: 10, tokensReturned: 5_000 })).tokens.value;
    expect(net).toBe(gross - 5_000);
  });

  it('never goes negative when Reticle cost more than the look it replaced', () => {
    expect(
      estimateImpactSavings(counts({ verdicts: 1, tokensReturned: 999_999 })).tokens.value,
    ).toBe(0);
  });

  it('still declares its basis as a MODEL, not a measurement', () => {
    // Deliberately unchanged in this pass. The constant stands for a screenshot look and is not
    // measured; the benchmark's per-tool numbers are a different comparison (whole-grid averages
    // with accuracy attached) and substituting one for the other is the denominator sloppiness that
    // makes a savings claim indefensible under challenge.
    expect(IMPACT_BASIS.TOKENS).toMatch(/screenshot/i);
  });
});
