import { beforeEach, describe, expect, it } from 'vitest';

import { documentHasSourceStamps, sourceFromDom } from './source.js';

/**
 * Telling "this element has no stamp" apart from "nothing on this page has one".
 *
 * The two look identical from a missing `source` field and call for completely different next
 * actions: the first is ordinary, the second means the stamping loader is not running and no
 * element will carry a source this session.
 */
function render(html: string): void {
  document.body.innerHTML = html;
}

describe('source stamp presence', () => {
  beforeEach(() => render(''));

  it('is false when the loader never ran', () => {
    render('<div><button id="b">Save</button></div>');

    expect(documentHasSourceStamps(document)).toBe(false);
  });

  it('is true when any element carries a stamp, even a distant one', () => {
    render(
      '<header data-reticle-source="src/Header.tsx:12:4">nav</header>' +
        '<main><button id="b">Save</button></main>',
    );

    expect(documentHasSourceStamps(document)).toBe(true);
  });

  it('separates the two cases for the same unstamped element', () => {
    // Same element, same missing source, two different diagnoses — which is the whole point.
    render('<div><button id="b">Save</button></div>');
    const unstamped = document.getElementById('b');
    expect(unstamped).not.toBeNull();
    expect(sourceFromDom(unstamped as Element)).toBeUndefined();
    expect(documentHasSourceStamps(document)).toBe(false);

    render(
      '<header data-reticle-source="src/Header.tsx:12:4">nav</header>' +
        '<main><button id="b2">Save</button></main>',
    );
    const stillUnstamped = document.getElementById('b2');
    expect(stillUnstamped).not.toBeNull();
    expect(sourceFromDom(stillUnstamped as Element)).toBeUndefined();
    expect(documentHasSourceStamps(document)).toBe(true);
  });

  it('is true for a stamped ancestor of the element itself', () => {
    render('<div data-reticle-source="src/App.tsx:104:10"><button id="b">Save</button></div>');
    const el = document.getElementById('b');
    expect(el).not.toBeNull();

    expect(sourceFromDom(el as Element)).toEqual({ file: 'src/App.tsx', line: 104 });
    expect(documentHasSourceStamps(document)).toBe(true);
  });
});
