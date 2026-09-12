import { describe, expect, it } from 'vitest';
import { affectedFlows } from './affected.js';

describe('affectedFlows', () => {
  it('selects flows whose sources include a changed file', () => {
    const flows = [
      { name: 'checkout', sources: ['src/Checkout.tsx', 'src/cart.ts'] },
      { name: 'login', sources: ['src/Login.tsx'] },
    ];
    const result = affectedFlows(flows, ['src/cart.ts']);
    expect(result.affected).toEqual(['checkout']);
    expect(result.unknownProvenance).toEqual([]);
  });

  it('always includes flows with no sources manifest (fail-safe)', () => {
    const flows = [
      { name: 'checkout', sources: ['src/Checkout.tsx'] },
      { name: 'legacy' }, // pre-2.2, unknown provenance
    ];
    const result = affectedFlows(flows, ['src/unrelated.ts']);
    expect(result.affected).toEqual(['legacy']);
    expect(result.unknownProvenance).toEqual(['legacy']);
  });

  it('matches across absolute vs repo-relative path forms and strips file:line', () => {
    const flows = [{ name: 'checkout', sources: ['/repo/src/Checkout.tsx:114'] }];
    const result = affectedFlows(flows, ['src/Checkout.tsx']);
    expect(result.affected).toEqual(['checkout']);
  });

  it('returns nothing affected when a fully-provenanced suite is untouched', () => {
    const flows = [{ name: 'checkout', sources: ['src/Checkout.tsx'] }];
    expect(affectedFlows(flows, ['src/other.ts']).affected).toEqual([]);
  });
});
