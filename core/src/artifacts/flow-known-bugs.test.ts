import { describe, it, expect } from 'vitest';
import { FlowFileSchema, staleKnownBugs } from './flow-types.js';

/**
 * A flow carries the bugs it is known to expose, and says when that record has gone stale.
 *
 * Without this, a suite that is red for a KNOWN reason is indistinguishable from one that just
 * broke — so either somebody re-investigates a bug already filed, or the whole flow gets
 * quarantined and stops watching the rest of the journey it covers.
 *
 * The half that makes it honest is staleness. A known-bug note is a claim about code, and code
 * moves. A note recorded against assertions that have since changed is worse than no note: it
 * explains away a NEW failure with an OLD excuse, which is the false-green shape in a different
 * costume. So the note records which assertions it was written against, and anything else is
 * reported as stale rather than trusted.
 */
const base = {
  version: 1 as const,
  name: 'checkout',
  createdAt: 0,
  steps: [],
};

describe('Flow.knownBugs', () => {
  it('parses a flow that records a known bug', () => {
    const parsed = FlowFileSchema.safeParse({
      ...base,
      knownBugs: [{ id: 'RET-412', summary: 'discount not applied to tax', assertions: ['a1'] }],
    });
    expect(parsed.success).toBe(true);
  });

  it('is optional — every flow written before this stays valid', () => {
    expect(FlowFileSchema.safeParse(base).success).toBe(true);
  });

  it('refuses a note with no id — an unattributable excuse is worse than none', () => {
    const parsed = FlowFileSchema.safeParse({
      ...base,
      knownBugs: [{ summary: 'something is wrong', assertions: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it('reports a note as STALE when the assertions it was written against are gone', () => {
    const stale = staleKnownBugs(
      [{ id: 'RET-412', summary: 'x', assertions: ['a1', 'a2'] }],
      ['a2', 'a3'],
    );
    expect(stale.map((b) => b.id)).toEqual(['RET-412']);
  });

  it('is not stale while every assertion it named still exists', () => {
    expect(
      staleKnownBugs([{ id: 'RET-412', summary: 'x', assertions: ['a1'] }], ['a1', 'a2']),
    ).toEqual([]);
  });

  it('a note naming NO assertions is always stale — it cannot be checked, so it cannot be trusted', () => {
    expect(staleKnownBugs([{ id: 'RET-9', summary: 'x', assertions: [] }], ['a1'])).toHaveLength(1);
  });
});
