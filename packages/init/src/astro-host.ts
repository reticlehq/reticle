/**
 * Which Astro file owns the document, and therefore where the SDK script belongs.
 *
 * The previous rule was "exactly one `.astro` file in `src/layouts/`". Measured on two real Astro
 * projects, it fired on neither: one has no `src/layouts/` at all and renders from
 * `src/pages/index.astro`; the other has three files there, two of which are partials. Both got a
 * printed recipe instead of a working install.
 *
 * A file COUNT cannot tell a layout from a partial, and a directory NAME cannot tell you where the
 * document shell is. `</body>` can — the file that closes the body is the one every page renders
 * through, and the only place a script reaches the whole app.
 *
 * Ambiguity is still refused rather than guessed. Two document shells means two entry points, and
 * silently instrumenting one of them would leave half the app unverified while reporting success.
 */

interface AstroCandidate {
  path: string;
  source: string;
}

/** Tolerant of whitespace and casing: `</body>`, `</BODY >`, `</body\n>`. */
const CLOSES_BODY = /<\/\s*body\s*>/i;

/** Layout files win over pages: a page shell is one route, a layout shell is what routes inherit. */
const LAYOUT_DIR = 'layouts/';

export function pickAstroHost(candidates: readonly AstroCandidate[]): AstroCandidate | undefined {
  const owners = candidates.filter((c) => CLOSES_BODY.test(c.source));
  if (0 === owners.length) return undefined;
  const layouts = owners.filter((c) => c.path.includes(LAYOUT_DIR));
  const preferred = layouts.length > 0 ? layouts : owners;
  return 1 === preferred.length ? preferred[0] : undefined;
}
