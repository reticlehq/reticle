/**
 * A text check reads the words as a user sees them (#1782).
 *
 * CSS `text-transform` paints a case the DOM does not hold. A case-exact check for "SAVED" against
 * `<span style="text-transform:uppercase">Saved</span>` answered `no` while the screen showed
 * SAVED. The check stays case-exact: it now holds against the DOM case or the painted case, and a
 * case that is on neither still misses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { matchQuery } from './query.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a case-exact text check on transformed text', () => {
  it('holds for the case the screen shows', () => {
    document.body.innerHTML = '<span style="text-transform:uppercase">Saved</span>';
    expect(matchQuery({ text: 'SAVED', matchCase: true }).matched).toBe(true);
  });

  it('holds for capitalize and lowercase the same way', () => {
    document.body.innerHTML =
      '<span style="text-transform:capitalize">order shipped</span>' +
      '<span style="text-transform:lowercase">DRAFT</span>';
    expect(matchQuery({ text: 'Order Shipped', matchCase: true }).matched).toBe(true);
    expect(matchQuery({ text: 'draft', matchCase: true }).matched).toBe(true);
  });

  it('still holds for the case the DOM holds', () => {
    document.body.innerHTML = '<span style="text-transform:uppercase">Saved</span>';
    expect(matchQuery({ text: 'Saved', matchCase: true }).matched).toBe(true);
  });

  it('still misses a case that is on neither the DOM nor the screen', () => {
    document.body.innerHTML = '<span style="text-transform:uppercase">Saved</span>';
    expect(matchQuery({ text: 'sAVED', matchCase: true }).matched).toBe(false);
    document.body.innerHTML = '<span>Saved</span>';
    expect(matchQuery({ text: 'SAVED', matchCase: true }).matched).toBe(false);
  });
});

describe('a text check on a sentence split across inline children', () => {
  it('matches the sentence a reader sees, in the visible state', () => {
    document.body.innerHTML = '<p>Order <strong>#42</strong> is ready</p>';
    const result = matchQuery({ text: 'Order #42 is ready', matchCase: true }, 'visible');
    expect(result.matched).toBe(true);
    expect(result.elements[0]?.role).toBe('paragraph');
  });

  it('still misses a sentence that is not on the page', () => {
    document.body.innerHTML = '<p>Order <strong>#43</strong> is ready</p>';
    expect(matchQuery({ text: 'Order #42 is ready', matchCase: true }, 'visible').matched).toBe(
      false,
    );
  });
});
