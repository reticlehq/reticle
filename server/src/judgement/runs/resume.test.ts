import { describe, expect, it } from 'vitest';
import type { JournalAction } from '@reticlehq/core';
import { resumeLines } from './resume.js';

let n = 0;
function verdict(claim: string, verified: string, observed?: string): JournalAction {
  n += 1;
  return {
    actionId: `a${String(n)}`,
    tool: 'reticle_act_and_wait',
    args: {},
    at: n,
    effect: { claim, verified, ...(observed === undefined ? {} : { observed }) },
  } as unknown as JournalAction;
}

describe('a resumed session still reports what did not hold', () => {
  const actions = [
    verdict('signal auth:granted', 'yes'),
    verdict('route /checkout', 'no', 'route /cart'),
    verdict('signal order:placed', 'unknown'),
    verdict('text "Saved"', 'no-fault'),
  ];
  const text = resumeLines({ actions, openIntents: ['buyer can check out'], notes: [] }).join('\n');

  it('lists failed and unproved claims as not done, with what was seen', () => {
    expect(text).toContain('1 proved · 1 failed · 2 not proved');
    expect(text).toMatch(/FAILED — not done \(1\):\n {2}- route \/checkout — saw: route \/cart/);
    expect(text).toContain('signal order:placed (unknown)');
    expect(text).toContain('text "Saved" (no-fault)');
    expect(text).toContain('buyer can check out');
  });

  it("a claim's LATEST verdict decides: a later yes clears it, a later no reopens it", () => {
    const later = resumeLines({
      actions: [
        ...actions,
        verdict('route /checkout', 'yes'),
        verdict('signal auth:granted', 'no'),
      ],
      openIntents: [],
      notes: [],
    }).join('\n');
    expect(later).toMatch(/FAILED — not done \(1\):\n {2}- signal auth:granted/);
    expect(later).not.toMatch(/FAILED[^\n]*\n {2}- route \/checkout/);
  });

  it('stays bounded whatever the journal holds', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      verdict(`claim ${String(i)} ${'x'.repeat(300)}`, 'no'),
    );
    const big = resumeLines({ actions: many, openIntents: [], notes: [] }).join('\n');
    expect(big.length).toBeLessThan(4000);
    expect(big).toContain('400 failed');
  });

  it('app notes are labelled as hints, never evidence', () => {
    const t = resumeLines({
      actions: [],
      openIntents: [],
      notes: ['the composer is labelled "Ask"'],
    });
    expect(t.join('\n')).toContain('App notes (hints for targeting, never evidence)');
  });
});
