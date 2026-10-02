/**
 * A whole view that rendered is not a message the app said.
 *
 * `appeared` earns its keep on small text: "Invalid credentials" turns a login that reports
 * `ok / settled / mutated` into one that says what went wrong. But an added node's `textContent`
 * flattens its ENTIRE subtree with no separators, so when a navigation swaps a view the field
 * becomes a page dump run together into one unreadable string.
 *
 * Measured on a real drive against the bench app, clicking Compose:
 *
 *   appeared: "Compose | generate a release note | DraftRelease note generatorTitle · commits on
 *              blurWhat shipped?GenerateOutputYour generated note appears here."
 *
 * 146 bytes, 36 tokens, on every navigation verdict, and no reader can act on any of it — note
 * "DraftRelease" and "blurWhat", which are two fragments with the boundary lost. The snapshot
 * already describes the new view properly, which makes dropping this the cheaper mistake, exactly
 * as it is for the bare-numeral case above.
 */

import { describe, expect, it } from 'vitest';
import { AppearedText } from './appeared-text.js';

const added = (el: Element): MutationRecord =>
  ({ type: 'childList', addedNodes: [el], target: document.body }) as unknown as MutationRecord;

const el = (html: string): Element => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild ?? host;
};

describe('a rendered view is not something the app said', () => {
  it('drops a container whose subtree is a composed view', () => {
    const view = el(
      '<section><h1>Release note generator</h1><label>Title</label><input/>' +
        '<label>What shipped?</label><button>Generate</button><h2>Output</h2>' +
        '<p>Your generated note appears here.</p></section>',
    );
    const appeared = new AppearedText();
    appeared.collect([added(view)]);
    expect(appeared.effect().appeared).toBeUndefined();
  });

  it('keeps a message, even wrapped in an element', () => {
    // The whole reason the field exists — this must survive the cut.
    const appeared = new AppearedText();
    appeared.collect([added(el('<div class="error">Invalid credentials</div>'))]);
    expect(appeared.effect().appeared).toBe('Invalid credentials');
  });

  it('keeps a message with a little markup inside it', () => {
    const appeared = new AppearedText();
    appeared.collect([added(el('<div>Could not save — <strong>try again</strong></div>'))]);
    expect(appeared.effect().appeared).toContain('Could not save');
  });
});
