import { describe, expect, it } from 'vitest';
import { buildHonestyBlock, HonestyGrade } from './honesty.js';

/**
 * The honesty block must never state something it cannot substantiate.
 *
 * It shipped `envelope: { samples: 0, sufficient: false }` on every single act, because
 * `envelopeSamples` has no producer anywhere in the codebase — it is declared, defaulted to 0, and
 * never fed. `coverage.pct` was likewise always 0, producing the incoherent pair `pct: 0,
 * partial: false` ("nothing was covered, and coverage was complete").
 *
 * That inverts the block's entire purpose. `reticle_act_and_wait`'s own description tells the agent to
 * gate on this block, so an agent that obeyed would reject 100% of green verdicts on a permanently
 * false `sufficient`. A field whose value never changes carries no information; a field that always
 * reads "insufficient" is worse, because it looks like a finding.
 *
 * Rule: substantiated → report it; unsubstantiated → omit the key. Absence is honest, a fabricated
 * zero is not.
 */

describe('honesty block substantiation', () => {
  it('OMITS the envelope when no samples were measured, rather than reporting a false "insufficient"', () => {
    const block = buildHonestyBlock({ grade: HonestyGrade.SIGNAL, attribution: 'window' });
    expect(block.envelope).toBeUndefined();
  });

  it('reports the envelope when samples ARE measured', () => {
    const block = buildHonestyBlock({ grade: HonestyGrade.SIGNAL, envelopeSamples: 5 });
    expect(block.envelope).toEqual({ samples: 5, sufficient: true });
  });

  it('marks an envelope insufficient only when it was actually measured and is thin', () => {
    const block = buildHonestyBlock({ grade: HonestyGrade.SIGNAL, envelopeSamples: 1 });
    expect(block.envelope).toEqual({ samples: 1, sufficient: false });
  });

  it('reports full coverage as 100, not 0', () => {
    // Nothing blind was reported during the window, so the SDK saw everything it is able to see.
    const block = buildHonestyBlock({ grade: HonestyGrade.SIGNAL, coveragePartial: false });
    expect(block.coverage).toEqual({ pct: 100, partial: false });
  });

  it('omits a coverage percentage when coverage is partial and no number was measured', () => {
    // "partial" is known; the exact fraction is not. Inventing 0 would understate a real verdict.
    const block = buildHonestyBlock({
      grade: HonestyGrade.SIGNAL,
      coveragePartial: true,
      blindSpots: ['partial — 1 cross-origin frame unobserved'],
    });
    expect(block.coverage.partial).toBe(true);
    expect(block.coverage.pct).toBeUndefined();
    expect(block.integrity.clean).toBe(false);
  });

  it('still reports integrity issues — that half was always substantiated', () => {
    const block = buildHonestyBlock({ grade: HonestyGrade.PRESENCE, truncated: true });
    expect(block.integrity.clean).toBe(false);
    expect(block.integrity.issues).toContain('capture truncated');
  });
});
