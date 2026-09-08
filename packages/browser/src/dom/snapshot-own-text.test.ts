/**
 * An element's OWN text must not vanish because it also has children.
 *
 * `directText` is consulted only for a `generic` role with no name, so any element carrying BOTH a
 * real role and its own text loses that text entirely — while a `generic` child's text survives and
 * is printed one level in. The result reads as an empty interpolation:
 *
 *     <p>{money(price)}<span> / mo for {count}</span></p>
 *
 *     - paragraph
 *       - text "/ mo for 1"
 *
 * The price is not there. A reporter twice concluded the app had a copy defect from exactly this,
 * on screens that were rendering correctly — once on a price line where the price WAS present, once
 * on a sentence whose spacing was reported broken when it was not. `reticle_query` returned the true
 * text immediately and disproved both.
 *
 * The snapshot is the FIRST thing an agent looks at, so a wrong reading here is the most expensive
 * kind: everything after it is reasoning about a page that does not exist.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildSnapshot } from './snapshot.js';

function mount(html: string): void {
  document.body.innerHTML = html;
}

afterEach(() => {
  document.body.innerHTML = '';
});

const treeOf = (): string => buildSnapshot({ mode: 'full' }).tree;

describe('an element keeps its own text alongside its children', () => {
  it('does not drop a paragraph’s own text when a child also has some', () => {
    mount('<p>$29<span> / mo for 1</span></p>');
    const tree = treeOf();
    expect(tree, 'the price is on the page and must be in the snapshot').toContain('$29');
    expect(tree, 'the child’s half must survive too').toContain('/ mo for 1');
  });

  it('keeps a generic container’s own text, which already worked', () => {
    mount('<div>alpha<span>beta</span></div>');
    const tree = treeOf();
    expect(tree).toContain('alpha');
    expect(tree).toContain('beta');
  });

  it('does not repeat text that an accessible name already carries', () => {
    // A button's name IS its text. Printing both would double every control on the page.
    mount('<button>Save</button>');
    const occurrences = treeOf().split('Save').length - 1;
    expect(occurrences, 'named controls say it once').toBe(1);
  });

  it('keeps the role rather than replacing the node with a bare text line', () => {
    // "- text" loses what kind of element it was, which is half of what a snapshot is for.
    mount('<p>hello<span> world</span></p>');
    expect(treeOf()).toContain('paragraph');
  });

  it('leaves whitespace-only own text out', () => {
    // `<div>\n  <span>x</span>\n</div>` has direct text that is only formatting. Printing it would
    // add a line per wrapper on every real page.
    mount('<p>\n  <span>x</span>\n</p>');
    expect(treeOf()).not.toMatch(/- text "\s*"/);
  });
});
