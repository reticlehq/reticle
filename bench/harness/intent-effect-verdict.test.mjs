import { describe, expect, it } from 'vitest';
import { intentEffectVerdict } from './intent-effect-verdict.mjs';

const arm = (rate, perRun) => ({
  present: true,
  runs: perRun.length,
  false_green_rate: rate,
  false_green_rate_per_run: perRun,
  false_green_spread:
    perRun.length < 2 ? null : +(Math.max(...perRun) - Math.min(...perRun)).toFixed(3),
});

describe('intentEffectVerdict', () => {
  /** The one result that must never pass quietly. */
  it('FAILS when the false-green rate is higher with intent+context on', () => {
    const v = intentEffectVerdict({
      off: arm(0.2, [0.2, 0.2, 0.2]),
      on: arm(0.8, [0.8, 0.8, 0.8]),
      runs: 3,
    });
    expect(v.ok).toBe(false);
    expect(v.outcome).toBe('regressed');
    expect(v.reason).toContain('WORSE');
    expect(v.delta).toBe(0.6);
  });

  it('does not conclude on a rise smaller than the observed run-to-run spread', () => {
    const v = intentEffectVerdict({
      off: arm(0.4, [0.2, 0.6]),
      on: arm(0.5, [0.3, 0.7]),
      runs: 2,
    });
    expect(v.ok).toBe(true);
    expect(v.outcome).toBe('inconclusive');
    expect(v.noise).toBe(0.4);
  });

  it('reports a fall larger than the noise as an improvement', () => {
    const v = intentEffectVerdict({
      off: arm(0.9, [0.9, 0.9]),
      on: arm(0.1, [0.1, 0.1]),
      runs: 2,
    });
    expect(v.outcome).toBe('improved');
    expect(v.ok).toBe(true);
    expect(v.delta).toBe(-0.8);
    expect(v.noise).toBe(0);
  });

  /** One run per arm proves nothing, and a gate that pretends otherwise is worse than no gate. */
  it('refuses to conclude on a single run per arm, because the noise is unobserved', () => {
    const v = intentEffectVerdict({ off: arm(0, [0]), on: arm(1, [1]), runs: 1 });
    expect(v.outcome).toBe('inconclusive');
    expect(v.noise).toBe(null);
    expect(v.reason).toContain('--runs 3');
  });

  /** A pass that measured nothing must FAIL — and must not read as a regression. */
  it('FAILS as not-measured when an arm did not run', () => {
    const v = intentEffectVerdict({ off: arm(0.5, [0.5, 0.5]), on: { present: false, runs: 0 } });
    expect(v.ok).toBe(false);
    expect(v.outcome).toBe('not-measured');
    expect(v.reason).toContain('NOT MEASURED');
    expect(v.reason).toContain('not a regression');
    expect(v.reason).toContain('ON (intent declared');
  });

  it('FAILS as not-measured when both arms are missing entirely', () => {
    expect(intentEffectVerdict({}).outcome).toBe('not-measured');
    expect(intentEffectVerdict().ok).toBe(false);
  });

  /** Runs happened, none of them settled anything: an empty denominator is unmeasured, not zero. */
  it('FAILS as not-measured when an arm ran but produced no gradeable claim', () => {
    const v = intentEffectVerdict({
      off: arm(0.5, [0.5, 0.5]),
      on: { present: true, runs: 3, false_green_rate: null, false_green_spread: null },
      runs: 3,
    });
    expect(v.outcome).toBe('not-measured');
    expect(v.reason).toContain('empty denominator');
  });
});
