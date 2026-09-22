import { describe, expect, it } from 'vitest';
import { parseInteractive } from './snapshot-tree.js';

/**
 * The format's own example, and the shapes that surround it.
 *
 * This had NO tests while being exported from core and read by several Node-side callers. They were
 * written to pin behaviour before removing a regex flagged as a polynomial ReDoS, so the removal
 * could be shown to change nothing a caller can see.
 */
describe('reading the snapshot tree', () => {
  it('returns only the lines carrying a ref', () => {
    const tree = ['- button "Pay $42.00" (ref=e4) [disabled]', '- text "no ref here"'].join('\n');
    expect(parseInteractive(tree)).toEqual([
      { ref: 'e4', desc: '- button "Pay $42.00" [disabled]' },
    ]);
  });

  it('takes the ref out of the description and trims what is left', () => {
    expect(parseInteractive('- link "Home" (ref=e1)')).toEqual([
      { ref: 'e1', desc: '- link "Home"' },
    ]);
  });

  it('leaves a single gap when the ref sat mid-line', () => {
    expect(parseInteractive('a (ref=e2) b')).toEqual([{ ref: 'e2', desc: 'a b' }]);
  });

  it('reads every referenced line, in order', () => {
    const tree = ['- a (ref=e1)', '- b', '- c (ref=e10)'].join('\n');
    expect(parseInteractive(tree).map((i) => i.ref)).toEqual(['e1', 'e10']);
  });

  it('says nothing about an empty tree', () => {
    expect(parseInteractive('')).toEqual([]);
  });

  /*
   * The input is page-derived, so a description CAN carry a long run of whitespace.
   *
   * Asserted as a correctness bound rather than a duration: a timing assertion is a statement about
   * the machine and fails only under load. What is pinned here is that a pathological line still
   * parses correctly; that it does so in linear time is a property of there being no backtracking
   * regex left to drive.
   */
  it('parses a line with a long whitespace run', () => {
    const line = `- button "${' '.repeat(5_000)}" (ref=e7)`;
    const [item] = parseInteractive(line);
    expect(item?.ref).toBe('e7');
    expect(item?.desc.startsWith('- button "')).toBe(true);
    expect(item?.desc.endsWith('"')).toBe(true);
  });
});
