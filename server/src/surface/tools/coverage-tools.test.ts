import { describe, expect, it } from 'vitest';
import { parseControls } from './coverage-tools.js';

const TREE = [
  '- main',
  '  - heading "Electron todos" (ref=e6)',
  '  - textbox "New todo" (ref=e7)',
  '  - button "Add" (ref=e8)',
  '  - list',
  '    - listitem "Wire Reticle in" (ref=e4)',
  '      - button "Archive" (ref=e9)',
  '  - button "Break something" (ref=e11)',
].join('\n');

describe('parseControls — the denominator for coverage', () => {
  it('finds every ref in the tree, with its label', () => {
    const controls = parseControls(TREE);
    expect(controls.map((c) => c.ref)).toEqual(['e6', 'e7', 'e8', 'e4', 'e9', 'e11']);
    expect(controls[2]).toEqual({ ref: 'e8', label: 'button "Add"' });
  });

  it('preserves document order, so the untouched list reads top-to-bottom', () => {
    expect(parseControls(TREE)[0]?.ref).toBe('e6');
  });

  it('counts a ref only once even if it appears twice', () => {
    const refs = parseControls(`${TREE}\n  - button "Add" (ref=e8)`).map((c) => c.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  /**
   * The denominator must never be UNDER-counted. A ref this parser fails to shape into a labelled
   * control still has to appear, because dropping it would silently shrink `total` and inflate the
   * exercised fraction — the one direction of error that reports better coverage than reality.
   */
  it('still counts a ref on a line it cannot label', () => {
    const controls = parseControls('  <weird formatting> (ref=e99)');
    expect(controls.map((c) => c.ref)).toContain('e99');
  });

  it('returns nothing for a tree with no refs', () => {
    expect(parseControls('- main\n  - paragraph')).toEqual([]);
  });
});
