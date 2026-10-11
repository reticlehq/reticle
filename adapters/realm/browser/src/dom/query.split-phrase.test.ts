/**
 * A phrase a reader sees whole must match whole, however the page splits it into elements.
 *
 * From a persona drive: an issue row read "found by CI", with the two words in sibling flex spans
 * and no whitespace node between them, so the DOM text was "found byCI" and `text contains "found by
 * CI"` could never hold. The Harness graded the goal `no` against a page that was right.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { matchQuery } from './query.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a phrase split across sibling elements', () => {
  it('matches across flex items the layout sets apart, with the space a reader sees', () => {
    document.body.innerHTML =
      '<div style="display:flex;gap:4px"><span>found by</span><span>CI</span></div>';
    const r = matchQuery({ text: 'found by CI', matchCase: true });
    expect(r.matched).toBe(true);
    expect(r.count).toBe(1);
  });

  it('matches across block children the same way', () => {
    document.body.innerHTML = '<div><div>Payment</div><div>accepted</div></div>';
    expect(matchQuery({ text: 'Payment accepted', matchCase: true }).matched).toBe(true);
  });

  it('still misses a phrase that is not on the page', () => {
    document.body.innerHTML =
      '<div style="display:flex"><span>found by</span><span>Ana</span></div>';
    expect(matchQuery({ text: 'found by CI', matchCase: true }).matched).toBe(false);
  });
});
