import { describe, expect, it } from 'vitest';
import { VerdictAttribution } from '@reticlehq/core';
import type { GapSummary } from './gap-summary.js';
import { gapHookLine, gapReportLines } from './gap-report.js';

const gap = (over: Partial<GapSummary>): GapSummary => ({
  claims: 0,
  held: 0,
  failed: 0,
  undecided: 0,
  nothingToProve: 0,
  undecidedBy: {},
  falseGreensCaught: 0,
  failures: [],
  ...over,
});

describe('gapHookLine — what a Stop hook prints when the agent says it is done', () => {
  it('says nothing was checked when the session made no claim at all', () => {
    expect(gapHookLine(gap({}))).toBe('Reticle: not verified. No claim was checked this session');
  });

  // An unknown is not a pass. Folding it anywhere else is the false green this whole release is about.
  it('names every answer that is not a yes, in counts', () => {
    expect(gapHookLine(gap({ claims: 3, failed: 1, undecided: 1, nothingToProve: 1 }))).toBe(
      'Reticle: not verified. 3 claims: 1 failed, 1 unknown, 1 proved nothing',
    );
  });

  it('is silent once a claim held', () => {
    expect(gapHookLine(gap({ claims: 2, held: 1, undecided: 1 }))).toBeUndefined();
  });
});

describe('gapReportLines — the session gap for a person', () => {
  it('leads with held of claimed, then the unknowns by who can act on them', () => {
    const lines = gapReportLines(
      gap({
        claims: 4,
        held: 2,
        failed: 1,
        undecided: 1,
        falseGreensCaught: 1,
        undecidedBy: { [VerdictAttribution.ENVIRONMENT]: 1 },
        failures: [{ claim: 'signal order:placed' }],
      }),
    );
    expect(lines[0]).toBe('2 of 4 claims held');
    expect(lines).toContain('1 failed, 1 of them a green a channel contradicted');
    expect(lines).toContain(`1 unknown (${VerdictAttribution.ENVIRONMENT}: 1)`);
    expect(lines).toContain('  ✗ signal order:placed');
  });

  it('says so plainly when nothing was claimed', () => {
    expect(gapReportLines(gap({}))).toEqual(['no claims this session, so nothing was verified']);
  });
});
