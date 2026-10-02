import { describe, expect, it } from 'vitest';
import { affectedFlows, isInteractiveSource, unflowedFiles } from './affected.js';

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

// The gate used to start from saved flows, so an edited component that no flow had ever touched
// affected nothing and the gate passed without the change being driven at all.
describe('unflowedFiles', () => {
  const flows = [{ name: 'checkout', sources: ['src/Checkout.tsx'] }];
  const interactive = (): boolean => true;

  it('names a changed interactive component that no flow covers', () => {
    expect(unflowedFiles(flows, ['src/Checkout.tsx', 'src/NewWizard.tsx'], interactive)).toEqual([
      'src/NewWizard.tsx',
    ]);
  });

  it('ignores non-component files, test files and display-only components', () => {
    const changed = ['src/api.ts', 'README.md', 'src/Wizard.test.tsx', 'src/Badge.vue'];
    expect(unflowedFiles(flows, changed, (f) => 'src/Badge.vue' !== f)).toEqual([]);
  });
});

describe('isInteractiveSource', () => {
  it('reads a handler prop or a native control as something a step can act on', () => {
    expect(isInteractiveSource('<button onClick={go}>Go</button>')).toBe(true);
    expect(isInteractiveSource('<input value={v} />')).toBe(true);
    expect(isInteractiveSource('<div @click="go">')).toBe(true);
    expect(isInteractiveSource('<div on:submit={go}>')).toBe(true);
  });

  it('reads a display-only component as nothing to act on', () => {
    expect(
      isInteractiveSource('export const Badge = ({ n }) => <span className="b">{n}</span>;'),
    ).toBe(false);
  });
});
