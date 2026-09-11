import { describe, expect, it } from 'vitest';
import { HARNESS_REVISION, provenanceVerdict } from './baseline-provenance.mjs';

/**
 * A baseline recorded by a harness that measured differently is not a baseline.
 *
 * The gate compares every fresh number against the previous row, and the previous rows were produced
 * by a harness with four integrity defects that all read in our favour: a measured-nothing guard that
 * covered a third of the passes, a lost cell that left the denominator, tools that never ran recorded
 * as having scored zero, and a scenario every tool detected off the URL string.
 *
 * Those rows are not merely stale. They are the wrong number, biased in one direction, and comparing
 * an honest run against them inverts the gate: an honest measurement looks like a regression, and a
 * real regression can hide inside the slack the old flattery left. The failure that costs the most is
 * the one that still looks like a pass.
 *
 * The README says so. A README is not a gate, and this file exists because the last four defects were
 * all things somebody had written down somewhere.
 */

const row = (revision) => (undefined === revision ? {} : { harness_revision: revision });

describe('provenanceVerdict', () => {
  it('accepts a baseline recorded by this harness', () => {
    expect(provenanceVerdict({ baseline: row(HARNESS_REVISION) }).ok).toBe(true);
  });

  it('REFUSES a baseline recorded before the harness stamped its revision', () => {
    // Every row written before the integrity fix. Unstamped is not "probably fine": it is precisely
    // the set of rows known to be measured differently.
    const v = provenanceVerdict({ baseline: row(undefined) });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/re-baseline/i);
  });

  it('REFUSES a baseline from an older harness revision', () => {
    const v = provenanceVerdict({ baseline: row(HARNESS_REVISION - 1) });
    expect(v.ok).toBe(false);
  });

  it('refuses a baseline from a NEWER harness than the one running', () => {
    // The checkout is behind the row. Comparing then measures the difference between two harnesses
    // and reports it as a change in the product.
    expect(provenanceVerdict({ baseline: row(HARNESS_REVISION + 1) }).ok).toBe(false);
  });

  it('passes when there is no baseline at all, which is a first run and not a lie', () => {
    expect(provenanceVerdict({ baseline: null }).ok).toBe(true);
    expect(provenanceVerdict({}).ok).toBe(true);
  });

  it('names the row it rejected, so the message is actionable rather than an accusation', () => {
    const v = provenanceVerdict({ baseline: { version: '2.10.0', ...row(undefined) } });
    expect(v.reason).toContain('2.10.0');
  });

  it('treats a non-numeric revision as absent rather than trusting it', () => {
    // A hand-edited or half-written row must not buy its way past this.
    expect(provenanceVerdict({ baseline: { harness_revision: 'latest' } }).ok).toBe(false);
    expect(provenanceVerdict({ baseline: { harness_revision: null } }).ok).toBe(false);
  });
});
