/**
 * Brace / paren matching for conservative source patchers.
 *
 * A count, not a parser. A `{` or `}` inside a string literal would fool it. That only ever
 * shortens or lengthens the window we search, so the worst case is a MANUAL bail or a missed
 * merge — never a corrupted file written as APPLY. A caller that must not be fooled runs the count
 * on `maskStringsAndComments(source)`, which keeps every index where it was.
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

/** What `c` does to the open count: +1 for the opener, -1 for the closer, 0 for anything else. */
function depthStep(c: string | undefined, open: '{' | '(', close: '}' | ')'): number {
  if (c === open) {
    return 1;
  }
  return c === close ? -1 : 0;
}

function matchingCloser(
  source: string,
  innerStart: number,
  open: '{' | '(',
  close: '}' | ')',
): number | undefined {
  let depth = 1;
  for (let i = innerStart; i < source.length; i++) {
    depth += depthStep(source[i], open, close);
    if (0 === depth) {
      return i;
    }
  }
  return undefined;
}

/** How many `{` are open at `index`, counted from the start of `source`. */
export function braceDepth(source: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    depth += depthStep(source[i], '{', '}');
  }
  return depth;
}

/**
 * The source with every string literal, regex literal and comment blanked to spaces, newlines kept,
 * so each index still points at the same place in the real source. Null when the scan does not end
 * cleanly: a string, comment or regex that never closes, or braces that do not balance.
 *
 * The counts below are fooled by a `{` inside a string, and a key search by a `plugins: [` in a
 * comment. A patcher that runs them on this masked copy is not, and edits the real source at the
 * same indices. The Vite patcher used to add a second `plugins` key whose list Vite never reads
 * (#2134). A source this scan cannot read is a manual step for the caller, never a guess.
 */
export function maskStringsAndComments(source: string): string | null {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if ('\n' !== out[k]) {
        out[k] = ' ';
      }
    }
  };
  /** The last character before `at` that is not whitespace, in the masked output so far. */
  const previousToken = (at: number): string => {
    for (let k = at - 1; k >= 0; k -= 1) {
      const c = out[k] ?? '';
      if (!/\s/.test(c)) {
        return c;
      }
    }
    return '';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    let stop: number | null;
    if ('/' === ch && '/' === next) {
      const end = source.indexOf('\n', i);
      stop = -1 === end ? source.length : end;
    } else if ('/' === ch && '*' === next) {
      const end = source.indexOf('*/', i + 2);
      stop = -1 === end ? null : end + 2;
    } else if ("'" === ch || '"' === ch || '`' === ch) {
      stop = closingQuote(source, i, ch);
    } else if ('/' === ch && REGEX_MAY_FOLLOW.includes(previousToken(i))) {
      stop = closingRegex(source, i);
    } else {
      i += 1;
      continue;
    }
    if (null === stop) {
      return null;
    }
    blank(i, stop);
    i = stop;
  }
  const masked = out.join('');
  return 0 === braceDepth(masked, masked.length) ? masked : null;
}

/** Where a `/` starts a regex literal rather than a division: after one of these, or at the start. */
const REGEX_MAY_FOLLOW = ['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';'];

/** The index just past the quote that closes the string opened at `at`, or null. */
function closingQuote(source: string, at: number, quote: string): number | null {
  let j = at + 1;
  while (j < source.length) {
    const c = source[j];
    if ('\\' === c) {
      j += 2;
    } else if (quote === c) {
      return j + 1;
    } else if ('\n' === c && '`' !== quote) {
      return null;
    } else {
      j += 1;
    }
  }
  return null;
}

/** The index just past the flags of the regex literal opened at `at`, or null. */
function closingRegex(source: string, at: number): number | null {
  let j = at + 1;
  let inClass = false;
  while (j < source.length) {
    const c = source[j];
    if ('\\' === c) {
      j += 2;
      continue;
    }
    if ('\n' === c) {
      return null;
    }
    if ('[' === c) {
      inClass = true;
    } else if (']' === c) {
      inClass = false;
    } else if ('/' === c && !inClass) {
      j += 1;
      while (j < source.length && /[a-z]/i.test(source[j] ?? '')) {
        j += 1;
      }
      return j;
    }
    j += 1;
  }
  return null;
}
