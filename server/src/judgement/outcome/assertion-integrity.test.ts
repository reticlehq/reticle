import { describe, expect, it } from 'vitest';
import type { Predicate } from '@reticlehq/core';
import { detectDowngrades, isAssertionDowngrade } from './assertion-integrity.js';

const signal = { kind: 'signal', name: 'order:placed' } as unknown as Predicate; // consequence
const net = { kind: 'net', urlContains: '/api/order' } as unknown as Predicate; // consequence
const presence = { kind: 'element', query: { role: 'button', name: 'OK' } } as unknown as Predicate; // presence-only

describe('isAssertionDowngrade', () => {
  it('flags a consequence weakened to presence-only', () => {
    expect(isAssertionDowngrade(signal, presence)).toBe(true);
    expect(isAssertionDowngrade(net, presence)).toBe(true);
  });

  it('does not flag a consequence that stayed a consequence', () => {
    expect(isAssertionDowngrade(signal, net)).toBe(false);
  });

  it('does not flag strengthening (presence → consequence)', () => {
    expect(isAssertionDowngrade(presence, signal)).toBe(false);
  });
});

describe('detectDowngrades', () => {
  it('reports each step whose assertion tier dropped', () => {
    const before = [
      { step: 0, expect: signal },
      { step: 1, expect: net },
      { step: 2, expect: presence },
    ];
    const after = [
      { step: 0, expect: presence }, // downgraded
      { step: 1, expect: net }, // unchanged
      { step: 2, expect: presence }, // still presence
    ];
    expect(detectDowngrades(before, after)).toEqual([{ step: 0 }]);
  });

  it('reports nothing when every assertion holds its tier', () => {
    const flow = [{ step: 0, expect: signal }];
    expect(detectDowngrades(flow, flow)).toEqual([]);
  });
});
