import { describe, expect, it } from 'vitest';
import { coverageVerdict } from './coverage-floor.mjs';

/**
 * A cell that times out or throws is recorded NOT MEASURED, and NOT MEASURED cells are EXCLUDED from
 * the catch-rate denominator rather than counted as misses. That exclusion is right — a scenario
 * nobody could measure is not a miss — and it has a cost nothing was watching: the rate stays 1.0
 * while the grid it is computed over shrinks. Coverage can fall to a single cell and the headline
 * reads exactly as it did over thirty.
 *
 * Both numbers were already in every history row. Nothing compared them.
 */

const row = (measured, total) => ({ measured_cells: measured, total_cells: total });

describe('coverageVerdict', () => {
  it('passes when the same number of cells was measured', () => {
    expect(coverageVerdict({ now: row(27, 30), last: row(27, 30) }).ok).toBe(true);
  });

  it('passes when more cells were measured than last time', () => {
    expect(coverageVerdict({ now: row(29, 30), last: row(27, 30) }).ok).toBe(true);
  });

  /** The defect this exists for: one cell died, the catch-rate did not move, the gate stayed green. */
  it('FAILS when a single cell was lost', () => {
    const v = coverageVerdict({ now: row(26, 30), last: row(27, 30) });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('26');
    expect(v.reason).toContain('27');
  });

  it('names the cells that went missing when the fresh row lists them', () => {
    const v = coverageVerdict({
      now: { measured_cells: 26, total_cells: 30, not_measured: ['network-timeout/devtools'] },
      last: row(27, 30),
    });
    expect(v.reason).toContain('network-timeout/devtools');
  });

  /**
   * Deliberately dropping a scenario is a decision somebody can make. Drifting into it is not, so it
   * is DECLARED — the same shape the token budget uses, and for the same reason: a gate that cannot
   * tell "we chose this" from "we regressed" gets muted, and a muted gate is worse than none.
   */
  it('passes a declared drop and echoes the stated reason', () => {
    const v = coverageVerdict({
      now: row(24, 27),
      last: row(27, 30),
      declaredDrop: 'devtools column retired, its MCP no longer builds',
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toContain('devtools column retired');
  });

  it('has no baseline to compare against on the first run', () => {
    expect(coverageVerdict({ now: row(27, 30), last: null }).ok).toBe(true);
    expect(coverageVerdict({ now: row(27, 30), last: {} }).ok).toBe(true);
  });

  /**
   * A fresh run that did not record how much it measured cannot be shown not to have shrunk. Reading
   * that as a pass is the green that means "we did not look", which is the failure this whole gate
   * exists to catch.
   */
  it('does not pass when the fresh run recorded no coverage at all', () => {
    const v = coverageVerdict({ now: {}, last: row(27, 30) });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('did not record');
    expect(coverageVerdict({ now: null, last: row(27, 30) }).ok).toBe(false);
  });

  it('treats a non-numeric cell count as absent rather than as zero', () => {
    expect(coverageVerdict({ now: { measured_cells: '27' }, last: row(27, 30) }).ok).toBe(false);
  });
});
