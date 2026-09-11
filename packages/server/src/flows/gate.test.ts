import { describe, expect, it } from 'vitest';
import { gateDecision } from './gate.js';

describe('gateDecision', () => {
  it('passes when every affected flow has a passing artifact', () => {
    const result = gateDecision({
      affected: ['checkout', 'login'],
      passing: ['checkout', 'login', 'search'],
    });
    expect(result.pass).toBe(true);
    expect(result.uncovered).toEqual([]);
  });

  it('blocks on an affected flow with no passing artifact', () => {
    const result = gateDecision({ affected: ['checkout', 'billing'], passing: ['checkout'] });
    expect(result.pass).toBe(false);
    expect(result.uncovered).toEqual(['billing']);
  });

  it('quarantines a flaky flow instead of blocking on it', () => {
    const result = gateDecision({ affected: ['checkout'], passing: [], flaky: ['checkout'] });
    expect(result.pass).toBe(true);
    expect(result.uncovered).toEqual([]);
    expect(result.quarantined).toEqual(['checkout']);
  });

  it('still blocks a non-flaky uncovered flow even when another is quarantined', () => {
    const result = gateDecision({
      affected: ['checkout', 'billing'],
      passing: [],
      flaky: ['checkout'],
    });
    expect(result.pass).toBe(false);
    expect(result.uncovered).toEqual(['billing']);
    expect(result.quarantined).toEqual(['checkout']);
  });
});

describe('gate — anti-reward-hacking: weakened or deleted coverage BLOCKS', () => {
  it('blocks when an affected flow weakened its assertions since the last passing run', () => {
    // The gaming vector: the flow "passes", but only because its mustHold dropped from a real
    // consequence (signal/net/state) to a fakeable presence check. A green bought that way must not pass.
    const r = gateDecision({
      affected: ['checkout'],
      passing: ['checkout'],
      downgraded: [{ flow: 'checkout', steps: [2] }],
    });
    expect(r.pass).toBe(false);
    expect(r.downgraded).toEqual([{ flow: 'checkout', steps: [2] }]);
    expect(r.uncovered).toEqual([]); // it IS covered — that is precisely why the downgrade must block
  });

  it('blocks when a flow covering a changed file was deleted rather than satisfied', () => {
    const r = gateDecision({ affected: [], passing: [], deleted: ['checkout'] });
    expect(r.pass).toBe(false);
    expect(r.deleted).toEqual(['checkout']);
  });

  it('a flaky flow is still quarantined (not the agent’s doing) while a downgrade still blocks', () => {
    const r = gateDecision({
      affected: ['flaky-one', 'checkout'],
      passing: ['checkout'],
      flaky: ['flaky-one'],
      downgraded: [{ flow: 'checkout', steps: [0] }],
    });
    expect(r.quarantined).toEqual(['flaky-one']);
    expect(r.pass).toBe(false);
  });

  it('stays green when nothing was weakened or deleted', () => {
    const r = gateDecision({ affected: ['checkout'], passing: ['checkout'] });
    expect(r.pass).toBe(true);
    expect(r.downgraded).toEqual([]);
    expect(r.deleted).toEqual([]);
  });
});
