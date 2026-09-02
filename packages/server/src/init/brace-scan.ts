/**
 * Brace / paren matching for conservative source patchers.
 *
 * A count, not a parser. A `{` or `}` inside a string literal would fool it. That only ever
 * shortens or lengthens the window we search, so the worst case is a MANUAL bail or a missed
 * merge — never a corrupted file written as APPLY.
 */

/**
 * The text from just inside an opening brace to its match.
 *
 * `at` is the index just past `{`. Shared by the Astro and electron-vite patchers, which both
 * need "the object literal after this key" and must agree on what that means.
 */
export function blockAfter(source: string, at: number): string {
  const end = matchingCloser(source, at, '{', '}');
  return end === undefined ? source.slice(at) : source.slice(at, end);
}

/**
 * Index of the matching `}` for an object whose inner start is `at` (just past `{`).
 * `undefined` when the braces never balance.
 */
export function matchingBraceEnd(source: string, at: number): number | undefined {
  return matchingCloser(source, at, '{', '}');
}

/**
 * Index of the matching `)` for a call whose opening `(` is at `openAt`.
 * `undefined` when the parens never balance.
 */
export function matchingParenEnd(source: string, openAt: number): number | undefined {
  if (source[openAt] !== '(') return undefined;
  return matchingCloser(source, openAt + 1, '(', ')');
}

function matchingCloser(
  source: string,
  innerStart: number,
  open: '{' | '(',
  close: '}' | ')',
): number | undefined {
  let depth = 1;
  for (let i = innerStart; i < source.length; i++) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (0 === depth) return i;
    }
  }
  return undefined;
}
