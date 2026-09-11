import { describe, it, expect } from 'vitest';
import { normalizeLines, diffLines, BaselineStore } from './baselines.js';

describe('baselines', () => {
  it('normalizeLines strips volatile refs and blank lines', () => {
    const tree = ['- button "Pay" (ref=e7)', '', '  - textbox "Card" (ref=e12) [value="x"]'].join(
      '\n',
    );
    expect(normalizeLines(tree)).toEqual(['- button "Pay"', '- textbox "Card" [value="x"]']);
  });

  it('diffLines detects removed and added elements', () => {
    const before = ['- button "Export"', '- button "Pay"'];
    const after = ['- button "Pay"', '- alert "Card declined"'];
    const { removed, added } = diffLines(before, after);
    expect(removed).toEqual(['- button "Export"']);
    expect(added).toEqual(['- alert "Card declined"']);
  });

  it('store saves and lists', () => {
    const store = new BaselineStore();
    store.save({ name: 'checkout', lines: ['- button "Pay"'], route: '/checkout' });
    expect(store.list()).toEqual(['checkout']);
    expect(store.get('checkout')?.route).toBe('/checkout');
  });
});
