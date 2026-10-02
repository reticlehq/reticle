/**
 * The implicit-role half of the one-engine promise.
 *
 * The matcher answers `{ role }` queries with Reticle's OWN `getRole`, so every HTML element whose
 * ARIA role comes from its tag must be classified there - anything missing goes SILENT rather than
 * wrong: `{ role: "cell" }` returns zero on a perfectly healthy table, indistinguishable from the
 * table being absent. Zero matches is the worst failure mode the product has, so the implicit
 * table is pinned case by case here, including the conditional ones:
 *
 *   - `section` is `region` only when it carries an accessible name, else a plain `generic`;
 *   - `td` becomes `gridcell` inside an explicit grid/treegrid context;
 *   - `th[scope="row"]` is a `rowheader`, otherwise a `columnheader`;
 *   - `area` is a `link` only when it has an `href`.
 */

import { describe, expect, it } from 'vitest';
import { getRole } from './a11y.js';
import { runQuery } from './query.js';
import { QueryBy } from '@reticlehq/core';

/** The element a case is about; a miss is a broken fixture, not an empty expectation. */
function byTag(tag: string): Element {
  const el = document.querySelector(tag);
  if (null === el) throw new Error(`fixture has no <${tag}>`);
  return el;
}

describe('implicit roles for structural markup', () => {
  const TABLE = '<table><tbody><tr><th scope="col">H</th><td>A</td></tr></tbody></table>';

  it('tr maps to row', () => {
    document.body.innerHTML = TABLE;
    expect(getRole(byTag('tr'))).toBe('row');
    expect(runQuery({ by: QueryBy.ROLE, value: 'row' }).count).toBe(1);
  });

  it.each([
    ['td', 'cell'],
    ['tbody', 'rowgroup'],
    ['thead', 'rowgroup'],
    ['tfoot', 'rowgroup'],
  ])('%s maps to %s', (tag, expected) => {
    document.body.innerHTML =
      'td' === tag
        ? '<table><tbody><tr><td>A</td></tr></tbody></table>'
        : `<table><${tag}><tr><td>A</td></tr></${tag}></table>`;
    expect(getRole(byTag(tag))).toBe(expected);
    // The role must not merely be REPORTED correctly - it must be FINDABLE by that exact string.
    expect(runQuery({ by: QueryBy.ROLE, value: expected }).count).toBe(1);
  });

  it('th defaults to columnheader', () => {
    document.body.innerHTML = TABLE;
    expect(getRole(byTag('th'))).toBe('columnheader');
  });

  it('th[scope=row] is a rowheader', () => {
    document.body.innerHTML =
      '<table><tbody><tr><th scope="row">A</th><td>1</td></tr></tbody></table>';
    expect(getRole(byTag('th'))).toBe('rowheader');
  });

  it('td inside an explicit grid is a gridcell', () => {
    const grid = document.createElement('div');
    grid.setAttribute('role', 'grid');
    const cell = document.createElement('td');
    grid.append(cell);
    expect(getRole(cell)).toBe('gridcell');
  });

  it.each([
    ['<select><option>One</option></select>', 'option', 'option'],
    ['<select><optgroup label="a"></optgroup></select>', 'optgroup', 'group'],
    ['<article>text</article>', 'article', 'article'],
    ['<fieldset><legend>g</legend></fieldset>', 'fieldset', 'group'],
    ['<details open><summary>More</summary>x</details>', 'details', 'group'],
    ['<progress value="1" max="2"></progress>', 'progress', 'progressbar'],
    ['<meter value="1" min="0" max="2"></meter>', 'meter', 'meter'],
    ['<output>42</output>', 'output', 'status'],
    ['<hr />', 'hr', 'separator'],
  ])('%s maps to %s', (html, tag, expected) => {
    document.body.innerHTML = html;
    expect(getRole(byTag(tag))).toBe(expected);
    expect(runQuery({ by: QueryBy.ROLE, value: expected }).count).toBe(1);
  });

  it('summary exposes as button, so the disclosure is clickable by the obvious role', () => {
    document.body.innerHTML = '<details><summary>More</summary>rest</details>';
    expect(getRole(byTag('summary'))).toBe('button');
    expect(runQuery({ by: QueryBy.ROLE, value: 'button', name: 'More' }).count).toBe(1);
  });
});

describe('conditional implicit roles', () => {
  it('a NAMED section is a region', () => {
    document.body.innerHTML = '<section aria-label="Filters">...</section>';
    expect(getRole(byTag('section'))).toBe('region');
    expect(runQuery({ by: QueryBy.ROLE, value: 'region' }).count).toBe(1);
  });

  it('an UNNAMED section stays generic instead of flooding pages with phantom regions', () => {
    document.body.innerHTML = '<section>...</section>';
    expect(getRole(byTag('section'))).toBe('generic');
    expect(runQuery({ by: QueryBy.ROLE, value: 'region' }).count).toBe(0);
  });

  it.each([
    ['aria-label', '<section aria-label="Status">...</section>'],
    ['aria-labelledby', '<div id="cap">Status</div><section aria-labelledby="cap">...</section>'],
    ['title', '<section title="Status">...</section>'],
  ])('a section named via %s is still a region', (_kind, html) => {
    document.body.innerHTML = html;
    expect(getRole(byTag('section'))).toBe('region');
  });

  it('area[href] is a link', () => {
    document.body.innerHTML =
      '<map name="m"><area href="/next" shape="rect" coords="0,0,9,9" /></map>';
    expect(getRole(byTag('area'))).toBe('link');
  });

  it('area without href stays generic', () => {
    document.body.innerHTML = '<map name="m"><area shape="rect" coords="0,0,9,9" /></map>';
    expect(getRole(byTag('area'))).toBe('generic');
    expect(runQuery({ by: QueryBy.ROLE, value: 'link' }).count).toBe(0);
  });
});
