/**
 * A failed verdict must not ship its causal summary twice.
 *
 * The incident: building the razorpay merchant-dashboard case study, the Reticle arm cost MORE
 * tokens than the Playwright MCP arm it was being compared against — 75,869 B against 57,302 B —
 * despite making half as many calls. Sizing every top-level key of all 56 responses found
 * `summary` at 17.7% and `capsule` at 17.0% of the run, and 9 of 9 capsules carried a
 * `summary` byte-identical to the `summary` two fields up on the SAME response: 11,171 B, **14% of
 * the entire run**, for zero information.
 *
 * Both are produced by `causalSummary()` over the same window, so they cannot diverge and there is
 * nothing to compare — it was pure repetition on the one path (a red verdict) where responses are
 * already at their largest and an agent is least able to skim.
 *
 * The persisted capsule KEEPS its summary: `capsule-store` writes it to be read later, on its own,
 * with no response around it. This guard pins the split — wire without, storage with — because
 * collapsing them in either direction is a silent regression: one re-inflates every red verdict,
 * the other writes a stored capsule nobody can read.
 */

import { describe, expect, it } from 'vitest';
import { buildDivergenceCapsule, wireCapsule } from './capsule.js';

const events = [
  {
    t: 10,
    type: 'net.request',
    data: { method: 'POST', url: '/api/v1/payments/pay_1/refund', status: 200, ok: true },
  },
] as unknown as Parameters<typeof buildDivergenceCapsule>[1];

describe('wireCapsule', () => {
  it('drops the summary the response already carries', () => {
    const full = buildDivergenceCapsule([], events);
    expect(full.summary, 'the built capsule should carry a summary to drop').toBeDefined();
    expect('summary' in wireCapsule(full)).toBe(false);
  });

  it('keeps everything a red verdict is actually read for', () => {
    const wire = wireCapsule(buildDivergenceCapsule([], events));
    // firstDivergence is the fault, blastRadius is the undeclared damage. Losing either would
    // trade a token saving for the diagnosis the capsule exists to deliver.
    expect('firstDivergence' in wire).toBe(true);
    expect('blastRadius' in wire).toBe(true);
  });

  it('does not mutate the capsule that gets persisted', () => {
    const full = buildDivergenceCapsule([], events);
    wireCapsule(full);
    expect(full.summary, 'the stored capsule must stay self-contained').toBeDefined();
  });
});
