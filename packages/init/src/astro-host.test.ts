/**
 * Astro auto-wiring never fired on either real Astro app.
 *
 * The rule was "exactly one .astro file in src/layouts/". Measured on two real projects:
 *   - one has NO src/layouts/ at all and renders from src/pages/index.astro;
 *   - the other has THREE (Layout, Header, Footer) — two of which are partials, not layouts.
 * Both fell back to a printed recipe, nothing was wired, and no session ever connected. This was
 * 2.4.1's headline install feature, dead on 100% of the apps it was written for.
 *
 * A file COUNT cannot tell a layout from a partial, and a directory NAME cannot tell you where the
 * document shell lives. `</body>` can: the file that closes the document body is the one every page
 * renders through, and it is the only place a script tag reaches the whole app.
 *
 * So the question is not "how many files are in src/layouts" but "which file owns the document".
 */

import { describe, expect, it } from 'vitest';
import { pickAstroHost } from './astro-host.js';

const SHELL = `---
const { title } = Astro.props;
---
<html lang="en">
  <body>
    <slot />
  </body>
</html>
`;
const PARTIAL = `---
const { items } = Astro.props;
---
<nav><slot /></nav>
`;

describe('picking the file that owns the Astro document', () => {
  it('picks the one that closes the body, out of several candidates', () => {
    // The real case: Layout + Header + Footer, where two are partials.
    const host = pickAstroHost([
      { path: 'src/layouts/Header.astro', source: PARTIAL },
      { path: 'src/layouts/Layout.astro', source: SHELL },
      { path: 'src/layouts/Footer.astro', source: PARTIAL },
    ]);
    expect(host?.path).toBe('src/layouts/Layout.astro');
  });

  it('finds it in src/pages when there is no layouts directory at all', () => {
    const host = pickAstroHost([{ path: 'src/pages/index.astro', source: SHELL }]);
    expect(host?.path).toBe('src/pages/index.astro');
  });

  it('refuses when SEVERAL files own a document — that is a real decision, not a guess', () => {
    // Two document shells means two entry points; picking one silently instruments half the app.
    expect(
      pickAstroHost([
        { path: 'src/layouts/Marketing.astro', source: SHELL },
        { path: 'src/layouts/App.astro', source: SHELL },
      ]),
    ).toBeUndefined();
  });

  it('refuses when nothing owns a document, rather than patching a partial', () => {
    expect(pickAstroHost([{ path: 'src/layouts/Header.astro', source: PARTIAL }])).toBeUndefined();
  });

  it('prefers a layout over a page when both own a document', () => {
    // A page shell is usually one route; a layout shell is what the others inherit.
    const host = pickAstroHost([
      { path: 'src/pages/index.astro', source: SHELL },
      { path: 'src/layouts/Layout.astro', source: SHELL },
    ]);
    expect(host?.path).toBe('src/layouts/Layout.astro');
  });

  it('is unbothered by whitespace and casing in the closing tag', () => {
    const spaced = SHELL.replace('</body>', '</BODY >');
    expect(pickAstroHost([{ path: 'src/layouts/L.astro', source: spaced }])?.path).toBe(
      'src/layouts/L.astro',
    );
  });

  it('returns nothing for an empty project rather than throwing', () => {
    expect(pickAstroHost([])).toBeUndefined();
  });
});
