/**
 * Text that a page shows is found, even when invisible format characters sit inside it.
 *
 * Field report on 3.9.0: `{kind: "text", contains: "$4,449"}` failed "no element matched", while
 * the table footer cell showed "$4,449". i18n formatters wrap a value in bidi isolates
 * (U+2068 … U+2069), and other code inserts a zero-width space or a word joiner. None of them is
 * painted, so the screen and the check agree on "$4,449", but the raw text did not, and the verdict
 * read `no` for text that is on the screen.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { matchQuery } from './query.js';

function footer(text: string): void {
  document.body.innerHTML =
    '<table><tbody><tr><td>Rent</td><td>$1,200</td></tr></tbody>' +
    '<tfoot><tr><td>Total</td><td data-testid="budget-total"></td></tr></tfoot></table>';
  document.querySelector('[data-testid="budget-total"]')?.append(text);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a text query over invisible format characters', () => {
  const invisible: readonly (readonly [string, string])[] = [
    ['bidi isolates', '$\u20684,449\u2069'],
    ['a zero-width space', '$\u200b4,449'],
    ['a word joiner', '$\u20604,449'],
    ['a soft hyphen', '$4,4\u00ad49'],
    ['a byte order mark', '\ufeff$4,449'],
  ];
  for (const [name, text] of invisible) {
    it(`finds text that holds ${name}`, () => {
      footer(text);
      expect(matchQuery({ text: '$4,449' }).count).toBe(1);
    });
  }

  it('finds it on a case-exact check too', () => {
    footer('$\u20684,449\u2069');
    expect(matchQuery({ text: '$4,449', matchCase: true }).count).toBe(1);
  });

  it('still does not match a value the screen shows differently', () => {
    // A no-break space is painted as a space, so "$ 4,449" is not "$4,449".
    footer('$\u00a04,449');
    expect(matchQuery({ text: '$4,449' }).count).toBe(0);
    footer('$4,450');
    expect(matchQuery({ text: '$4,449' }).count).toBe(0);
  });
});
