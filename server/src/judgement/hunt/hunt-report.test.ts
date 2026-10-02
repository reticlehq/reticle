import { describe, expect, it } from 'vitest';
import { summarizeHunt, type HuntRun } from './hunt-report.js';

const run = (label: string, kinds: string[], stepsRun = 5): HuntRun => ({
  label,
  stepsRun,
  anomalies: kinds.map((kind) => ({ kind })),
});

describe('summarizeHunt — the arithmetic behind the core claim', () => {
  it('counts contradictions separately from single-channel faults', () => {
    const s = summarizeHunt([
      run('a1b2c3', ['ui-advanced-request-failed', 'console-error']),
      run('d4e5f6', ['dead-control']),
    ]);
    expect(s.contradictions).toBe(1);
    expect(s.singleChannelFaults).toBe(2);
  });

  /**
   * The claim is about CHANGES that carried a false green, not about raw anomaly count. One broken
   * control clicked five times is one bug and five anomalies; quoting the anomaly count would inflate
   * the finding by however aggressively the crawler happened to click.
   */
  it('counts flagged CHECKOUTS, not raw findings, in the headline', () => {
    const s = summarizeHunt([
      run('a1', ['duplicate-request', 'duplicate-request', 'duplicate-request']),
      run('b2', []),
    ]);
    expect(s.runsWithContradictions).toBe(1);
    expect(s.contradictions).toBe(3);
    expect(s.headline).toContain('1 of 2');
  });

  it('names the flagged checkouts so each can be confirmed by hand', () => {
    const s = summarizeHunt([run('sha-good', []), run('sha-bad', ['response-ignored'])]);
    expect(s.flagged).toEqual(['sha-bad']);
  });

  it('says "candidate" — an unconfirmed flag is not yet a bug', () => {
    expect(summarizeHunt([run('x', ['signal-contradicted'])]).headline).toContain('candidate');
  });
});

/**
 * The denominator is where this kind of measurement usually lies to itself. A checkout where the app
 * never came up drove nothing, and counting it as a clean run dilutes the rate with non-observations
 * — the arithmetic equivalent of reporting a green because no test ran.
 */
describe('a run that drove nothing is never counted as clean', () => {
  it('excludes zero-step runs from the denominator', () => {
    const s = summarizeHunt([run('drove', ['dead-control'], 4), run('never-booted', [], 0)]);
    expect(s.runs).toBe(2);
    expect(s.runsWithCoverage).toBe(1);
    // The denominator the headline quotes must be the covered runs, not the raw run count.
    expect(s.headline).toContain('1 merged changes crawled');
    expect(s.headline).not.toContain('2 merged');
  });

  it('refuses to report cleanliness when nothing was driven at all', () => {
    const s = summarizeHunt([run('a', [], 0), run('b', [], 0)]);
    expect(s.headline).toContain('nothing was measured');
    expect(s.headline).not.toMatch(/no cross-channel contradictions found/);
  });

  it('qualifies a clean sweep rather than presenting it as proof', () => {
    const s = summarizeHunt([run('a', []), run('b', [])]);
    expect(s.headline).toContain('confirm coverage was real');
  });

  it('handles an empty corpus without inventing a result', () => {
    expect(summarizeHunt([]).headline).toContain('nothing was measured');
  });
});

describe('byKind gives the distribution the A/B should be powered on', () => {
  it('tallies every kind, contradiction or not', () => {
    const s = summarizeHunt([
      run('a', ['ui-advanced-request-failed', 'console-error']),
      run('b', ['ui-advanced-request-failed']),
    ]);
    expect(s.byKind['ui-advanced-request-failed']).toBe(2);
    expect(s.byKind['console-error']).toBe(1);
  });
});
